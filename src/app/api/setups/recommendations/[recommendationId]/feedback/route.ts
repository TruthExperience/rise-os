// src/app/api/setups/recommendations/[recommendationId]/feedback/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { pbSetupFeedback, type SetupAdjustment } from '@/lib/pitboss-llm';

interface FeedbackRequestBody {
  feedback_text: string;
  driver_id?:    string;
}

interface ParamRange {
  param_key:     string;
  min_value:     number;
  max_value:     number;
  default_value: number | null;
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
    .select('id, league_id, car_class_id, track_id, conditions, session_type, driver_id, generated_setup, confidence')
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

  // 2. Pull param ranges for this car class so we can clamp deltas after the LLM responds
  const { data: ranges, error: rangesErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_parameter_ranges')
    .select('param_key, min_value, max_value, default_value')
    .eq('car_class_id', rec.car_class_id)
    .in('param_key', knownParamKeys);

  if (rangesErr) {
    return NextResponse.json(
      { error: `Failed to load param ranges: ${rangesErr.message}` },
      { status: 500 }
    );
  }

  const rangeMap = new Map<string, ParamRange>(
    (ranges ?? []).map((r) => [r.param_key, r])
  );

  // 3. Call the LLM layer (worker-side /setup-feedback — engine stays pure/LLM-free)
  const llmResult = await pbSetupFeedback(
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
        llm_tags:           {
          parse_error: true,
          raw:         llmResult.raw ?? null,
          model:       llmResult.model,
        },
      });

    if (logErr) {
      return NextResponse.json(
        { error: `Failed to log feedback: ${logErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        adjustments: [],
        summary: 'Model response could not be parsed. Flagged for manual review.',
        parse_error: true,
        resulting_recommendation_id: null,
      },
      { status: 200 }
    );
  }

  // 5. Defense-in-depth: re-validate + clamp every adjustment, never trust one validation layer
  const cleanAdjustments: SetupAdjustment[] = [];
  for (const adj of llmResult.adjustments) {
    if (!knownParamKeys.includes(adj.param_key)) continue;
    if (typeof adj.delta !== 'number' || !Number.isFinite(adj.delta)) continue;
    if (!['low', 'medium', 'high'].includes(adj.confidence)) continue;

    const range = rangeMap.get(adj.param_key);
    if (range) {
      const current = generatedSetup[adj.param_key] ?? range.default_value ?? 0;
      const proposed = current + adj.delta;
      const clamped = Math.min(range.max_value, Math.max(range.min_value, proposed));
      // Re-express delta in terms of the clamped result so downstream math stays consistent
      adj.delta = clamped - current;
    }

    cleanAdjustments.push(adj);
  }

  // 6. No valid adjustments — log feedback, but don't create a new recommendation
  if (cleanAdjustments.length === 0) {
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
      return NextResponse.json(
        { error: `Failed to log feedback: ${logErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        adjustments: [],
        summary: llmResult.summary || 'No valid adjustments could be derived from this feedback.',
        parse_error: false,
        resulting_recommendation_id: null,
      },
      { status: 200 }
    );
  }

  // 7. Build the adjusted setup and insert a new recommendation, chained via parent_recommendation_id
  const adjustedSetup = { ...generatedSetup };
  for (const adj of cleanAdjustments) {
    adjustedSetup[adj.param_key] = (adjustedSetup[adj.param_key] ?? 0) + adj.delta;
  }

  const feedbackTags = cleanAdjustments.map((a) => a.param_key);

  const { data: newRec, error: insertRecErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_recommendations')
    .insert({
      league_id:                rec.league_id,
      car_class_id:              rec.car_class_id,
      track_id:                  rec.track_id,
      conditions:                rec.conditions,
      session_type:              rec.session_type,
      driver_id:                  driver_id ?? rec.driver_id ?? null,
      generated_setup:            adjustedSetup,
      baseline_used:              false,
      model:                      llmResult.model,
      confidence:                 rec.confidence,
      parent_recommendation_id:   recommendationId,
      feedback_tags:              feedbackTags,
      adjustment_summary:         llmResult.summary,
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
      llm_adjustments:              cleanAdjustments,
      llm_summary:                  llmResult.summary,
      llm_tags:                     { model: llmResult.model, provider: llmResult.provider },
      resulting_recommendation_id:  newRec.id,
    })
    .select('id')
    .single();

  if (insertFeedbackErr) {
    return NextResponse.json(
      { error: `Failed to log feedback: ${insertFeedbackErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      feedback_id:                 feedbackRow.id,
      resulting_recommendation_id: newRec.id,
      adjustments:                 cleanAdjustments,
      adjusted_setup:               adjustedSetup,
      summary:                      llmResult.summary,
      disclaimer:                   llmResult.disclaimer,
      parse_error:                  false,
    },
    { status: 200 }
  );
}
