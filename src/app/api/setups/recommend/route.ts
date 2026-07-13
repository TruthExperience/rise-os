import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { buildRecommendation } from '@/lib/pitboss/setup-engine';
import { fetchParamRanges, fetchOverrides, fetchSubmissions } from '@/lib/pitboss/setup-engine-data';
import { resolveDriverIdFromSession } from '@/lib/pitboss/resolveDriver';

interface RecommendRequestBody {
  league_id?:    string | null;
  car_class_id:  string;
  track_id:      string;
  conditions:    'dry' | 'wet' | 'mixed';
  session_type:  'race' | 'qualifying' | 'sprint' | 'time_trial' | 'practice';
  // Discord snowflake from session.user.discordId (next-auth jwt strategy,
  // token.sub / p.id). Resolved server-side to a real pitboss.drivers.id —
  // never trust a client-supplied driver_id for identity purposes.
  discord_id?:   string | null;
  // Optional direct override for non-session callers (e.g. admin tooling,
  // backfill scripts) that already know the driver row. Ignored if
  // discord_id resolves successfully.
  driver_id?:    string | null;
}

export async function POST(req: NextRequest) {
  let body: RecommendRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    league_id = null,
    car_class_id,
    track_id,
    conditions,
    session_type,
    discord_id = null,
    driver_id: driverIdOverride = null,
  } = body;

  if (!car_class_id || !track_id || !conditions || !session_type) {
    return NextResponse.json(
      { error: 'car_class_id, track_id, conditions, and session_type are required' },
      { status: 400 }
    );
  }

  // Resolve the real driver id from the Discord snowflake. Falls back to an
  // explicit driver_id override only when no discord_id was supplied or it
  // didn't resolve to a known driver — e.g. someone signed in via Discord
  // but hasn't been added to pitboss.drivers yet.
  let driver_id: string | null = null;
  if (discord_id) {
    driver_id = await resolveDriverIdFromSession(discord_id);
  }
  if (!driver_id && driverIdOverride) {
    driver_id = driverIdOverride;
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
