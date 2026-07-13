import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { buildRecommendation } from '@/lib/pitboss/setup-engine';
import { fetchParamRanges, fetchOverrides, fetchSubmissions } from '@/lib/pitboss/setup-engine-data';

interface RecommendRequestBody {
  league_id?:    string | null;
  car_class_id:  string;
  track_id:      string;
  conditions:    'dry' | 'wet' | 'mixed';
  session_type:  'race' | 'qualifying' | 'sprint' | 'time_trial' | 'practice';
  driver_id?:    string | null;
}

export async function POST(req: NextRequest) {
  let body: RecommendRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { league_id = null, car_class_id, track_id, conditions, session_type, driver_id = null } = body;

  if (!car_class_id || !track_id || !conditions || !session_type) {
    return NextResponse.json(
      { error: 'car_class_id, track_id, conditions, and session_type are required' },
      { status: 400 }
    );
  }

  let paramRanges, overrides, submissions;
  try {
    [paramRanges, overrides, submissions] = await Promise.all([
      fetchParamRanges(car_class_id, session_type),
      fetchOverrides(track_id, car_class_id),
      fetchSubmissions({ trackId: track_id, carClassId: car_class_id, conditions, sessionType: session_type }),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load setup engine inputs' },
      { status: 500 }
    );
  }

  if (paramRanges.length === 0) {
    return NextResponse.json(
      { error: 'No parameter ranges configured for this car class / session type' },
      { status: 422 }
    );
  }

  const engineResult = buildRecommendation({
    paramRanges,
    overrides,
    submissions,
    requestingLeagueId: league_id,
  });

  const { data: newRec, error: insertErr } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_recommendations')
    .insert({
      league_id,
      car_class_id,
      track_id,
      conditions,
      session_type,
      driver_id,
      generated_setup: engineResult.generated_setup,
      rationale:        engineResult.rationale,
      confidence:       engineResult.confidence,
      baseline_used:    engineResult.baseline_used,
      model:            engineResult.model,
      source_submission_ids: submissions.map((s) => s.id),
    })
    .select('id, generated_setup, rationale, confidence, baseline_used, model, created_at')
    .single();

  if (insertErr || !newRec) {
    return NextResponse.json(
      { error: `Failed to save recommendation: ${insertErr?.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(newRec, { status: 200 });
}
