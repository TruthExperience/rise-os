import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { pbSetupFeedback } from '@/lib/pitboss-llm';
import { applyFeedbackAdjustments, type FeedbackAdjustment, type GeneratedRecommendation } from '@/lib/pitboss/setup-engine';
import { fetchParamRanges, fetchOverrides } from '@/lib/pitboss/setup-engine-data';

interface FeedbackRequestBody {
  feedback_text: string;
  driver_id?:    string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { recommendationId: string } }
) {
  const { recommendationId } = params;

  let body: FeedbackRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { feedback_text, driver_id } = body;

  if (!feedback_text?.trim()) {
    return NextResponse.json({ error: 'feedback_text is required' }, { status: 400 });
  }

  // 1. Load the recommendation being reacted to
  const { data: rec, error: recErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_recommendations')
    .select('id, league_id, car_class_id, track_id, conditions, session_type, driver_id, generated_setup, rationale, confidence, baseline_used, model')
    .eq('id', recommendationId)
    .single();

  if (recErr || !rec) {
    return NextResponse.json(
      { error: `Recommendation not found: ${recErr?.message ?? recommendationId}` },
      { status: 404 }
    );
  }

  const generatedSetup = (rec.generated_setup ?? {}) as Record<string, number>;
  const knownParamKeys = Object.keys(generatedSetup);

  if (knownParamKeys.length === 0) {
    return NextResponse.json(
      { error: 'Recommendation has no setup params to adjust against' },
      { status: 422 }
    );
  }

  // 2. Load param ranges + overrides — applyFeedbackAdjustments needs these
  //    for override-aware clamping, not just raw min/max.
  let paramRanges, overrides;
  try {
    [paramRanges, overrides] = await Promise.all([
      fetchParamRanges(rec.car_class_id, rec.session_type),
      fetchOverrides(rec.track_id, rec.car_class_id),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load setup engine inputs' },
      { status: 500 }
    );
  }

  // 3. Call the LLM layer (worker-side /setup-feedback — engine stays pure/LLM-free)
  // ADDED — wrap in try/catch. Previously an uncaught exception here (bad
  // PITBOSS_WORKER_URL, network failure, non-JSON worker response) bypassed
  // every parse_error/logging path below and surfaced a raw error string
  // straight to the driver-facing UI ("The string did not match the
  // expected pattern.").
  let llmResult;
  try {
    llmResult = await pbSetupFeedback(
      feedback_text,
      knownParamKeys,
      {
        car_class_id:  rec.car_class_id,
        track_id:      rec.track_id,
        conditions:    rec.conditions,
        session_type:  rec.session_type,
        current_setup: generatedSetup,
      },
      rec.league_id
    );
  } catch (err) {
    // ADDED — log this the same way a parse_error is logged, so it shows up
    // in setup_feedback for review, then return a clean 502 instead of
    // letting the raw exception bubble to the client unhandled.
    const detail = err instanceof Error ? err.message : 'Unknown error contacting setup feedback service';

    const { error: logErr } = await supabaseAdmin
      .schema('pitboss')
      .from('setup_feedback')
      .insert({
        recommendation_id: recommendationId,
        driver_id:          driver_id ?? rec.driver_id ?? null,
        feedback_text,
        llm_adjustments:    [],
        llm_summary:        null,
        llm_tags:           { transport_error: true, detail },
      });

    if (logErr) {
      // Non-fatal — still return the original transport error to the client.
      console.error('Failed to log transport-error feedback:', logErr.message);
    }

    return NextResponse.json(
      { error: `Setup feedback service unavailable: ${detail}` },
      { status: 502 }
    );
  }

  if ('error' in llmResult) {
    return NextResponse.json({ error: llmResult.error }, { status: 502 });
  }

  // 4. Parse failure — log the feedback, don't fabricate adjustments, flag for manual review
  if (llmResult.parse_error) {
    const { error: logErr } = await supabaseAdmin
      .schema('pitboss')
      .from('setup_feedback')
      .insert({
        recommendation_id: recommendationId,
        driver_id:          driver_id ?? rec.driver_id ?? null,
        feedback_text,
        llm_adjustments:    [],
        llm_summary:        null,
        llm_tags:           { parse_error: true, raw: llmResult.raw ?? null, model: llmResult.model },
      });

    if (logErr) {
      return NextResponse.json({ error: `Failed to log feedback: ${logErr.message}` }, { status: 500 });
    }

    return NextResponse.json(
      { adjustments: [], summary: 'Model response could not be parsed. Flagged for manual review.', parse_error: true, resulting_recommendation_id: null },
      { status: 200 }
    );
  }

  // 5. Defense-in-depth: re-validate shape before handing to the engine.
  //    The engine itself will also silently ignore any param_key it doesn't
  //    recognize (see applyFeedbackAdjustments), but we still gate here so
  //    we can tell the difference between "nothing to apply" and "engine
  //    rejected everything" for the response.
  const validated: FeedbackAdjustment[] = [];
  for (const adj of llmResult.adjustments) {
    if (!knownParamKeys.includes(adj.param_key)) continue;
    if (typeof adj.delta !== 'number' || !Number.isFinite(adj.delta)) continue;
    if (!['low', 'medium', 'high'].includes(adj.confidence)) continue;
    validated.push({ param_key: adj.param_key, delta: adj.delta, reason: adj.reasoning });
  }

  if (validated.length === 0) {
    const { error: logErr } = await supabaseAdmin
      .schema('pitboss')
      .from('setup_feedback')
      .insert({
        recommendation_id: recommendationId,
        driver_id:          driver_id ?? rec.driver_id ?? null,
        feedback_text,
        llm_adjustments:    [],
        llm_summary:        llmResult.summary,
        llm_tags:           { model: llmResult.model, no_valid_adjustments: true },
      });

    if (logErr) {
      return NextResponse.json({ error: `Failed to log feedback: ${logErr.message}` }, { status: 500 });
    }

    return NextResponse.json(
      { adjustments: [], summary: llmResult.summary || 'No valid adjustments could be derived from this feedback.', parse_error: false, resulting_recommendation_id: null },
      { status: 200 }
    );
  }

  // 6. Let the engine apply the deltas — override-aware clamp, per-round cap,
  //    step-rounding, rationale tracking, and confidence decay all live here.
  const base: GeneratedRecommendation = {
    generated_setup: generatedSetup,
    rationale:        (rec.rationale ?? {}) as GeneratedRecommendation['rationale'],
    confidence:       Number(rec.confidence),
    baseline_used:    Boolean(rec.baseline_used),
    model:            rec.model,
  };

  const adjustedResult = applyFeedbackAdjustments({
    base,
    paramRanges,
    overrides,
    adjustments: validated,
  });

  const feedbackTags = validated.map((a) => a.param_key);

  // 7. Insert the adjusted recommendation, chained via parent_recommendation_id
  const { data: newRec, error: insertRecErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_recommendations')
    .insert({
      league_id:                 rec.league_id,
      car_class_id:               rec.car_class_id,
      track_id:                   rec.track_id,
      conditions:                 rec.conditions,
      session_type:               rec.session_type,
      driver_id:                   driver_id ?? rec.driver_id ?? null,
      generated_setup:             adjustedResult.generated_setup,
      rationale:                   adjustedResult.rationale,
      baseline_used:               adjustedResult.baseline_used,
      model:                       adjustedResult.model,
      confidence:                  adjustedResult.confidence,
      parent_recommendation_id:    recommendationId,
      feedback_tags:               feedbackTags,
      adjustment_summary:          llmResult.summary,
    })
    .select('id')
    .single();

  if (insertRecErr || !newRec) {
    return NextResponse.json(
      { error: `Failed to create adjusted recommendation: ${insertRecErr?.message}` },
      { status: 500 }
    );
  }

  // 8. Log the feedback, linked to the recommendation it produced
  const { data: feedbackRow, error: insertFeedbackErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_feedback')
    .insert({
      recommendation_id:           recommendationId,
      driver_id:                    driver_id ?? rec.driver_id ?? null,
      feedback_text,
      llm_adjustments:              validated,
      llm_summary:                  llmResult.summary,
      llm_tags:                     { model: llmResult.model, provider: llmResult.provider },
      resulting_recommendation_id:  newRec.id,
    })
    .select('id')
    .single();

  if (insertFeedbackErr) {
    return NextResponse.json({ error: `Failed to log feedback: ${insertFeedbackErr.message}` }, { status: 500 });
  }

  return NextResponse.json(
    {
      feedback_id:                 feedbackRow.id,
      resulting_recommendation_id: newRec.id,
      adjustments:                 validated,
      adjusted_setup:               adjustedResult.generated_setup,
      summary:                      llmResult.summary,
      disclaimer:                   llmResult.disclaimer,
      parse_error:                  false,
    },
    { status: 200 }
  );
}
