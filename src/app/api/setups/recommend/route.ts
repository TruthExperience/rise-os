import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  buildRecommendation,
  applyTeamAndDriverBias,
  applySessionBias,
  applyDriverStyleBias,
} from '@/lib/pitboss/setup-engine';
import {
  fetchParamRanges,
  fetchOverrides,
  fetchSubmissions,
  fetchTeamTraits,
  fetchCareerDriverStats,
  fetchDriverStyleProfile,
} from '@/lib/pitboss/setup-engine-data';
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
  // In-game team/driver being tuned for — distinct from the pitboss.drivers
  // identity above. Links to car_class_teams / car_class_team_drivers.
  car_team_id?:              string | null;
  car_driver_id?:            string | null;
  car_driver_name_freetext?: string | null;
  // "League Driver" vs "Career Mode Driver" picker: when set to Career Mode
  // Driver, this points at pitboss.career_mode_drivers and its Pace/
  // Racecraft/Awareness/Experience stats nudge the setup. car_team_id above
  // is independent of this — both can be present and stack.
  career_driver_id?: string | null;
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
    car_team_id = null,
    car_driver_id = null,
    car_driver_name_freetext = null,
    career_driver_id = null,
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

  let paramRanges, overrides, submissions, teamTraits, careerDriverStats, driverStyleProfile;
  try {
    [paramRanges, overrides, submissions, teamTraits, careerDriverStats, driverStyleProfile] =
      await Promise.all([
        fetchParamRanges(car_class_id, session_type),
        fetchOverrides(track_id, car_class_id),
        fetchSubmissions({ trackId: track_id, carClassId: car_class_id, conditions, sessionType: session_type }),
        car_team_id ? fetchTeamTraits(car_team_id) : Promise.resolve(null),
        career_driver_id ? fetchCareerDriverStats(career_driver_id) : Promise.resolve(null),
        // Style profile is tied to the resolved pitboss.drivers identity,
        // not the in-game car_team_id/career_driver_id — same as the
        // driver-style-profile route, it's "my own record", not a param.
        driver_id ? fetchDriverStyleProfile(driver_id) : Promise.resolve(null),
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

  let engineResult = buildRecommendation({
    paramRanges,
    overrides,
    submissions,
    requestingLeagueId: league_id,
  });

  // Layer the deterministic team/driver bias on top, only if either source
  // was actually requested and resolved to a real row.
  if (teamTraits || careerDriverStats) {
    engineResult = applyTeamAndDriverBias({
      base: engineResult,
      paramRanges,
      overrides,
      teamTraits,
      driverStats: careerDriverStats,
    });
  }

  // Session-type bias is always applied — session_type is required on every
  // request, and "practice" is an intentional no-op (empty weight map) so
  // this call is a safe no-cost pass-through for that case.
  engineResult = applySessionBias({
    base: engineResult,
    paramRanges,
    overrides,
    sessionType: session_type,
  });

  // Driver style bias only applies if the caller resolved to a real driver
  // and that driver has filled out a style profile. "balanced" preference
  // (or no profile at all) is a no-op, same as practice above.
  if (driverStyleProfile) {
    engineResult = applyDriverStyleBias({
      base: engineResult,
      paramRanges,
      overrides,
      carFeelPreference: driverStyleProfile.car_feel_preference as any,
    });
  }

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
      car_team_id,
      car_driver_id,
      car_driver_name_freetext,
      career_driver_id,
    })
    .select('id, generated_setup, rationale, confidence, baseline_used, model, car_team_id, career_driver_id, created_at')
    .single();

  if (insertErr || !newRec) {
    return NextResponse.json(
      { error: `Failed to save recommendation: ${insertErr?.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(newRec, { status: 200 });
}
