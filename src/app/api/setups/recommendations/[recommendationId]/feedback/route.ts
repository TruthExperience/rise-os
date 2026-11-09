import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';
import { pbSetupFeedback } from '@/lib/pitboss-llm';
import { applyFeedbackAdjustments, type FeedbackAdjustment, type GeneratedRecommendation } from '@/lib/pitboss/setup-engine';
import { fetchParamRanges, fetchOverrides } from '@/lib/pitboss/setup-engine-data';
import { fetchTelemetryContext } from '@/lib/pitboss/setup-engine-telemetry';

export const dynamic = 'force-dynamic';
// The worker walks a free-model waterfall (10s per model), so a slow run can
// pass the old 25s client timeout. Give the route and the worker call room.
export const maxDuration = 60;
const SETUP_FEEDBACK_TIMEOUT_MS = 55_000;

const MAX_FEEDBACK_LENGTH = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FeedbackRequestBody {
  feedback_text: string;
  // driver_id / discord_id in the body are ignored. The driver is always the
  // signed-in one (see getAuthedDriver below).
  driver_id?:    string;
  discord_id?:   string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { recommendationId: string } }
) {
  // Every call here costs an LLM request and writes new recommendation rows,
  // so it needs a signed-in driver, and attribution comes from the session.
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseAdmin = createAdminClient();
  const { recommendationId } = params;

  if (!UUID_RE.test(recommendationId)) {
    return NextResponse.json({ error: 'Invalid recommendation id' }, { status: 400 });
  }

  let body: FeedbackRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { feedback_text } = body ?? ({} as FeedbackRequestBody);

  if (typeof feedback_text !== 'string' || !feedback_text.trim()) {
    return NextResponse.json({ error: 'feedback_text is required' }, { status: 400 });
  }
  if (feedback_text.length > MAX_FEEDBACK_LENGTH) {
    return NextResponse.json(
      { error: `feedback_text must be ${MAX_FEEDBACK_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }

  // 1. Load the recommendation being reacted to
  const { data: rec, error: recErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_recommendations')
    .select('id, league_id, car_class_id, track_id, conditions, session_type, driver_id, generated_setup, rationale, confidence, baseline_used, model, car_team_id, career_driver_id')
    .eq('id', recommendationId)
    .single();

  if (recErr || !rec) {
    return NextResponse.json(
      { error: `Recommendation not found: ${recErr?.message ?? recommendationId}` },
      { status: 404 }
    );
  }

  // Only the driver the recommendation was generated for can react to it.
  // Recommendations generated while signed out have no driver_id; those stay
  // open to any signed-in driver who holds the (unguessable) id.
  if (rec.driver_id && rec.driver_id !== driver.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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

  // 2b. Measured telemetry for this driver/track/class (falls back to the pool).
  //     Best-effort: never throws, returns { available: false } on any problem.
  const telemetryContext = await fetchTelemetryContext({
    driverId:    driver.id,
    trackId:     rec.track_id,
    carClassId:  rec.car_class_id,
    sessionType: rec.session_type,
  });

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
        // null when no telemetry exists; the worker prompt handles both cases.
        // upload_ids are DB ids the LLM can't use; drop them to keep the prompt small.
        telemetry:     telemetryContext.available
          ? (({ upload_ids, ...rest }) => rest)(telemetryContext)
          : null,
      },
      rec.league_id,
      SETUP_FEEDBACK_TIMEOUT_MS
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
        driver_id:          driver.id,
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
        driver_id:          driver.id,
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
        driver_id:          driver.id,
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

  // 6b. Final range/step check in SQL. The engine already clamps, but this is
  //     the same validator the recommend path relies on, and it records what
  //     (if anything) it had to correct. Falls back to the engine output if
  //     the RPC fails or returns an unexpected shape.
  let finalSetup: Record<string, number> = adjustedResult.generated_setup as Record<string, number>;
  let validatorViolations: unknown[] = [];
  try {
    const { data: vData, error: vErr } = await supabaseAdmin
      .schema('pitboss')
      .rpc('validate_setup', {
        p_car_class_id:  rec.car_class_id,
        p_setup:         adjustedResult.generated_setup,
        p_session_type:  rec.session_type,
      });

    const vSetup = (vData as { setup?: unknown } | null)?.setup;
    if (!vErr && vSetup && typeof vSetup === 'object' && !Array.isArray(vSetup) && Object.keys(vSetup).length > 0) {
      // Merge so a param the validator doesn't know about (it drops unknown
      // keys) keeps the engine's value instead of vanishing from the setup.
      finalSetup = { ...finalSetup, ...(vSetup as Record<string, number>) };
      const violations = (vData as { violations?: unknown }).violations;
      validatorViolations = Array.isArray(violations) ? violations : [];
    } else if (vErr) {
      console.error('validate_setup RPC failed, using engine output:', vErr.message);
    }
  } catch (err) {
    console.error('validate_setup RPC threw, using engine output:', err instanceof Error ? err.message : err);
  }

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
      driver_id:                   driver.id,
      car_team_id:                 rec.car_team_id,
      career_driver_id:            rec.career_driver_id,
      generated_setup:             finalSetup,
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
      driver_id:                    driver.id,
      feedback_text,
      llm_adjustments:              validated,
      llm_summary:                  llmResult.summary,
      llm_tags:                     {
        model: llmResult.model,
        provider: llmResult.provider,
        ...(validatorViolations.length > 0 ? { validator_violations: validatorViolations } : {}),
      },
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
      adjusted_setup:               finalSetup,
      summary:                      llmResult.summary,
      disclaimer:                   llmResult.disclaimer,
      parse_error:                  false,
    },
    { status: 200 }
  );
}
