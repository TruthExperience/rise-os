// src/app/api/pitboss/setups/telemetry-ingest/route.ts
//
// Accepts a single-lap F1 25 telemetry JSON export (the shape produced by
// UDP-capture tools — top-level team/track/weather/carSetup/tyres/driver
// objects plus a `telemetry` array of per-frame samples) and turns it into:
//
//   1. A pitboss.setup_submissions row — carSetup maps directly onto our
//      param_key naming, so a valid telemetry-backed lap becomes a real,
//      verified data point for the existing weighted-average engine
//      (buildRecommendation() in setup-engine.ts) with no changes needed
//      there. This is deliberately the *simplest* integration: telemetry
//      uploads are just another submission source, same as a manual driver
//      submission or an admin-entered community setup.
//   2. A pitboss.setup_telemetry_uploads row — archives the full raw
//      payload plus a few derived per-lap summaries (tyre wear/temp deltas,
//      sector times). Not used by the recommendation engine today; this is
//      storage for the telemetry-specific features planned next (wear/temp
//      trend analysis, braking-point comparison, etc.) so laps don't need
//      to be re-uploaded once those land.
//
// IDEMPOTENCY: (session_uid, lap_num) is unique per lap. A live session's
// capture tool can and does retry uploads (flaky connection, client-side
// timeout-and-resend, etc.) — this route MUST treat a retry of a lap it's
// already ingested as a no-op-with-refresh, not as a new data point.
// Before creating anything, it checks setup_telemetry_uploads for an
// existing row with this (session_uid, lap_num). If found: update that
// row's archive fields (in case the retried payload has any different
// data — e.g. a fuller frame capture) and return the ALREADY-EXISTING
// submission_id with 200, WITHOUT touching setup_submissions again. Only
// a genuinely new lap creates a new setup_submissions row. Previously this
// check didn't exist: every retry created a fresh, duplicate "verified"
// setup_submissions row (silently skewing buildRecommendation()'s
// weighted average toward whichever lap happened to retry) before failing
// on the *archive* insert's unique constraint — the failure you'd see in
// logs was really just the second, more visible symptom of that.
//
// NOTE: this route was originally at
// api/pitboss/setups/telemetry-upload/route.ts and was renamed to
// telemetry-ingest. The original folder name silently never made it into
// the Next.js build manifest (page compiled fine, API route did not — same
// failure mode previously hit and fixed by renaming style-profile ->
// driver-style-profile). No logic changed, only the route path.
//
// Accepts the request body in any of these forms:
//   - Raw JSON POST (Content-Type: application/json): the lap object
//     itself as the top-level body — { lapNum, track, carSetup,
//     telemetry: [...], ... }. This is the actual output of the capture
//     tool.
//   - JSON file upload (Content-Type: multipart/form-data): a .json file
//     attached under any field name, containing the same raw lap shape,
//     plus optional sibling form fields `car_class_code` and `league_id`
//     (this is how TelemetryUploadPage's file picker sends it — the file
//     itself has no car_class_code/league_id, those come from the form's
//     dropdown/input next to the picker).
//   - Wrapped JSON: { telemetry: <lap object>, car_class_code?, league_id? }
//     — kept for any caller that already sends it this way, in either
//     raw-body or file-upload form.
// Raw vs. wrapped is distinguished by checking for a top-level `lapNum`,
// which only exists on the raw lap shape.
//
// Track resolution is name-based (pitboss.f1_track_name_aliases), not by
// the numeric F1 game trackId in the payload — see that table's comment
// for why. Car class is NOT inferred from the payload's `game` field
// (observed as inconsistent even within the same actual game version —
// see TelemetryUploadPage's inferCarClassCode for the signals that
// actually do work) — callers pass car_class_code explicitly, defaulting
// to F1_2025.
//
// sessionType translation: the raw F1 UDP m_sessionType enum only knows
// "Nth race session this weekend" (race1/race2/race3) — it does NOT know
// sprint vs. feature race vs. Grand Prix. What race2 actually means
// depends on category and weekend format:
//
//   F2 (any weekend):      race1 = sprint,  race2 = feature race
//   F1, sprint weekend:    race1 = sprint,  race2 = Grand Prix
//   F1, standard weekend:  race1 = the only race (no race2 sent)
//
// resolveSessionType() below maps P1's raw sessionType string into our
// canonical SessionType. Category is read from tyres.tyreCompound (e.g.
// "f2SuperSoft" vs "soft"/"medium"/"hard") rather than `formula` or
// `game` — both of those have been observed sending unreliable/generic
// values ("other", inconsistent game builds — see mapCarSetupToParamValues
// comment above and TelemetryUploadPage's inferCarClassCode).
//
// OPEN QUESTION — not yet resolved: what raw sessionType string P1 sends
// for a *standard* (non-sprint) F1 race weekend's only race. If it's also
// "race1", that's ambiguous with F2/sprint-weekend race1 (= sprint) the
// same way race2 is, and resolveSessionType's race1 branch below would
// need the same category-aware disambiguation race2 gets. Currently
// race1 always resolves to "sprint" — confirm this before trusting
// standard-weekend F1 race1 uploads.
//
// CASING: resolveSessionType lowercases rawSessionType before matching,
// and every case label below is written lowercase.
//
// CONFIRMED against a real capture (Melbourne, lap 1): the tool sends the
// official F1 25 spec label camelCased verbatim — "Short Practice" ->
// "shortPractice" — not an abbreviation. That real payload's sessionType
// was literally "shortPractice", which the PRE-EXISTING 'shortp' case did
// NOT match ('shortPractice'.toLowerCase() is 'shortpractice', a
// different string) — a confirmed bug: that valid short-practice lap
// would have been rejected with a 400. 'shortq' and 'osq' are the same
// kind of wrong guess (correct forms are 'shortQualifying' /
// 'oneShotQualifying'), presumed equally broken though not yet caught in
// a real payload the way shortPractice was. The abbreviations are left in
// place below (harmless — they just never match anything real) and the
// correct camelCase-derived forms have been added alongside them for
// every official session type.
//
// Also observed in that same payload: "game": "f123", despite
// sessionType clearly being F1 25's label ("shortPractice" isn't a valid
// F1 23 label — F1 23's enum only has abbreviated "Short P"). Confirms
// the file's existing note that `game` is unreliable and shouldn't be
// trusted for anything, including car class inference (which the file
// already avoids doing on this field).

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';
import type { SessionType } from '@/lib/pitboss/setup-engine';
import { getTelemetrySession } from '@/lib/telemetry';
import { buildCoachingReport } from '@/lib/pitboss/telemetry-coach';
import { persistCoachingReport } from '@/lib/pitboss/coaching-history';

export const dynamic = 'force-dynamic';

const DEFAULT_CAR_CLASS_CODE = 'F1_2025';
const TELEMETRY_CONFIDENCE = 0.85;

function conditionsFromWeatherCode(code: number): 'dry' | 'wet' | 'mixed' {
  if (code <= 2) return 'dry';
  if (code === 3) return 'mixed';
  return 'wet';
}

function isF2Compound(tyreCompound: string | undefined | null): boolean {
  return typeof tyreCompound === 'string' && tyreCompound.toLowerCase().startsWith('f2');
}

function resolveSessionType(rawSessionType: string, tyreCompound: string | undefined | null): SessionType | null {
  switch (rawSessionType.toLowerCase()) {
    case 'race1':
      return 'sprint';
    case 'race2':
      return 'race';
    case 'race':
    case 'race3':
      return 'race';
    case 'qualifying':
    case 'qualifying1':
    case 'qualifying2':
    case 'qualifying3':
    case 'shortqualifying':
    case 'oneshotqualifying':
    case 'q1':
    case 'q2':
    case 'q3':
    case 'shortq':
    case 'osq':
      return 'qualifying';
    case 'sprint':
    case 'sprintqualifying':
    case 'sprintshootout1':
    case 'sprintshootout2':
    case 'sprintshootout3':
    case 'shortsprintshootout':
    case 'oneshotsprintshootout':
      return 'sprint';
    case 'time_trial':
    case 'timetrial':
      return 'time_trial';
    case 'practice':
    case 'practice1':
    case 'practice2':
    case 'practice3':
    case 'shortpractice':
    case 'p1':
    case 'p2':
    case 'p3':
    case 'shortp':
      return 'practice';
    default:
      return null;
  }
}

function mapCarSetupToParamValues(carSetup: any): Record<string, number> {
  return {
    front_arb: carSetup.suspension.frontAntiRollBars,
    rear_arb: carSetup.suspension.rearAntiRollBars,
    front_ride_height: carSetup.suspension.frontRideHeight,
    rear_ride_height: carSetup.suspension.rearRideHeight,
    front_suspension: carSetup.suspension.frontSuspension,
    rear_suspension: carSetup.suspension.rearSuspension,
    brake_pressure: carSetup.brakes.brakePressure,
    front_brake_bias: carSetup.brakes.brakeBias,
    front_toe_out: carSetup.suspensionGeometry.frontToeOut,
    rear_toe_in: carSetup.suspensionGeometry.rearToeIn,
    front_camber: carSetup.suspensionGeometry.frontCamber,
    rear_camber: carSetup.suspensionGeometry.rearCamber,
    diff_adjustment_on_throttle: carSetup.transmission.onThrottleDifferential,
    diff_adjustment_off_throttle: carSetup.transmission.offThrottleDifferential,
    front_left_tyre_pressure: carSetup.tyres.frontLeft,
    front_right_tyre_pressure: carSetup.tyres.frontRight,
    rear_left_tyre_pressure: carSetup.tyres.rearLeft,
    rear_right_tyre_pressure: carSetup.tyres.rearRight,
    front_wing_aero: carSetup.aerodynamics.frontWing,
    rear_wing_aero: carSetup.aerodynamics.rearWing,
  };
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function averageCorners(frames: any[], key: string): number[] {
  const sums = [0, 0, 0, 0];
  for (const frame of frames) {
    const v = frame[key];
    for (let i = 0; i < 4; i++) sums[i] += v[i];
  }
  return sums.map((s) => s / frames.length);
}

interface LapPayload {
  team: { id: number; name: string; shortName: string };
  appVersion: string;
  lapNum: number;
  sector1Time: number;
  sector2Time: number;
  sector3Time: number;
  lapTime: number;
  lapValid: boolean;
  sessionType: string;
  sessionUID: number | string;
  timestamp: number;
  game: string;
  track: { id: number; name: string; lengthInMeters: number };
  weather: { weather: number; trackTemperature: number; airTemperature: number };
  tyres: { tyres: string; tyreCompound: string };
  driver: { id: number; name: string; shortName: string };
  carSetup: any;
  telemetry: any[];
}

interface WrappedBody {
  league_id?: string | null;
  car_class_code?: string;
  telemetry: LapPayload;
}

interface ExtractedBody {
  json: any;
  formCarClassCode?: string;
  formLeagueId?: string;
}

async function extractBody(req: NextRequest): Promise<ExtractedBody> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    let file: File | null = null;
    for (const value of formData.values()) {
      if (value instanceof File) {
        file = value;
        break;
      }
    }
    if (!file) {
      throw new Error('No file found in the uploaded form data');
    }
    const text = await file.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Uploaded file "${file.name}" is not valid JSON`);
    }

    const formCarClassCode = formData.get('car_class_code');
    const formLeagueId = formData.get('league_id');
    return {
      json,
      formCarClassCode: typeof formCarClassCode === 'string' ? formCarClassCode : undefined,
      formLeagueId: typeof formLeagueId === 'string' ? formLeagueId : undefined,
    };
  }

  return { json: await req.json() };
}

export async function POST(req: NextRequest) {
  const supabaseAdmin = createAdminClient();

  let extracted: ExtractedBody;
  try {
    extracted = await extractBody(req);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 400 }
    );
  }
  const rawBody = extracted.json;

  const isRawShape = typeof rawBody?.lapNum === 'number';
  const lap: LapPayload | undefined = isRawShape ? rawBody : (rawBody as WrappedBody)?.telemetry;
  const league_id: string | null =
    extracted.formLeagueId?.trim() ||
    (!isRawShape ? (rawBody as WrappedBody)?.league_id ?? null : null) ||
    null;
  const car_class_code: string =
    extracted.formCarClassCode ||
    (!isRawShape ? (rawBody as WrappedBody)?.car_class_code : undefined) ||
    DEFAULT_CAR_CLASS_CODE;

  if (!lap || !lap.carSetup || !lap.track || !lap.telemetry || !Array.isArray(lap.telemetry)) {
    return NextResponse.json(
      { error: 'Missing or malformed telemetry payload — expected the full single-lap F1 25 export' },
      { status: 400 }
    );
  }

  if (!lap.lapValid) {
    return NextResponse.json(
      { error: 'Lap is not valid (off-track/corner-cutting flagged by the game) — not usable as a setup data point' },
      { status: 422 }
    );
  }

  if (lap.telemetry.length === 0) {
    return NextResponse.json({ error: 'Telemetry frame array is empty' }, { status: 422 });
  }

  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Could not resolve driver identity for this session' }, { status: 401 });
  }

  const sessionType = resolveSessionType(lap.sessionType, lap.tyres?.tyreCompound);
  if (!sessionType) {
    return NextResponse.json({ error: `Unrecognized session_type in payload: ${lap.sessionType}` }, { status: 400 });
  }

  const session_uid = String(lap.sessionUID);

  // IDEMPOTENCY CHECK — must happen before any insert.
  const { data: existingUpload, error: existingUploadError } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_telemetry_uploads')
    .select('id, submission_id')
    .eq('session_uid', session_uid)
    .eq('lap_num', lap.lapNum)
    .maybeSingle();

  if (existingUploadError) {
    return NextResponse.json(
      { error: `Failed to check for existing telemetry upload: ${existingUploadError.message}` },
      { status: 500 }
    );
  }

  const trackName = lap.track.name.trim().toLowerCase();
  const { data: alias } = await supabaseAdmin
    .schema('pitboss')
    .from('f1_track_name_aliases')
    .select('track_id')
    .eq('game_track_name', trackName)
    .maybeSingle();

  if (!alias) {
    return NextResponse.json(
      {
        error: `No track mapping found for "${lap.track.name}". Add it to pitboss.f1_track_name_aliases and retry.`,
      },
      { status: 422 }
    );
  }
  const track_id = alias.track_id as string;

  const { data: carClass, error: carClassError } = await supabaseAdmin
    .schema('pitboss')
    .from('car_classes')
    .select('id')
    .eq('code', car_class_code)
    .maybeSingle();

  if (carClassError || !carClass) {
    return NextResponse.json({ error: `Unknown car_class_code: ${car_class_code}` }, { status: 400 });
  }
  const car_class_id = carClass.id as string;

  const conditions = conditionsFromWeatherCode(lap.weather.weather);

  let ranges;
  try {
    ranges = await fetchParamRanges(car_class_id, sessionType);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load param ranges' },
      { status: 500 }
    );
  }
  if (ranges.length === 0) {
    return NextResponse.json(
      { error: 'No parameter ranges configured for this car class / session type' },
      { status: 422 }
    );
  }

  let setup_values: Record<string, number>;
  try {
    setup_values = mapCarSetupToParamValues(lap.carSetup);
  } catch {
    return NextResponse.json({ error: 'carSetup payload is missing expected fields' }, { status: 400 });
  }

  const rangeByKey = Object.fromEntries(ranges.map((r) => [r.param_key, r]));
  const outOfRange = Object.entries(setup_values).filter(([key, value]) => {
    const range = rangeByKey[key];
    return !range || typeof value !== 'number' || Number.isNaN(value) || value < range.min_value || value > range.max_value;
  });
  if (outOfRange.length > 0) {
    return NextResponse.json(
      { error: `Setup value(s) out of range for this car class: ${outOfRange.map(([k]) => k).join(', ')}` },
      { status: 400 }
    );
  }

  const frames = lap.telemetry;

  // RETRY PATH
  if (existingUpload) {
    const { error: refreshError } = await supabaseAdmin
      .schema('pitboss')
      .from('setup_telemetry_uploads')
      .update({
        lap_time_seconds: lap.lapTime,
        sector1_time_seconds: lap.sector1Time,
        sector2_time_seconds: lap.sector2Time,
        sector3_time_seconds: lap.sector3Time,
        lap_valid: lap.lapValid,
        weather_code: lap.weather.weather,
        track_temperature: lap.weather.trackTemperature,
        air_temperature: lap.weather.airTemperature,
        tyre_compound: lap.tyres?.tyreCompound ?? null,
        tyre_wear_start: frames[0].tyresWear,
        tyre_wear_end: frames[frames.length - 1].tyresWear,
        tyre_surface_temp_avg: averageCorners(frames, 'tyresSurfaceTemperature'),
        tyre_inner_temp_avg: averageCorners(frames, 'tyresInnerTemperature'),
        frame_count: frames.length,
        raw_payload: lap,
      })
      .eq('id', existingUpload.id);

    if (refreshError) {
      console.error('telemetry-ingest: failed to refresh archive on retry (original upload intact):', refreshError.message);
    }

    return NextResponse.json(
      {
        submission: { id: existingUpload.submission_id },
        telemetry_upload_id: existingUpload.id,
        resolved: { track_id, car_class_id, conditions, session_type: sessionType },
        retry: true,
      },
      { status: 200 }
    );
  }

  // NEW LAP PATH
  const { data: submission, error: submissionError } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_submissions')
    .insert({
      league_id,
      car_class_id,
      track_id,
      conditions,
      session_type: sessionType,
      setup_values,
      source: 'telemetry',
      source_name: `Telemetry: ${lap.driver?.shortName ?? driver.id}`,
      source_url: null,
      confidence: TELEMETRY_CONFIDENCE,
      verified: true,
      submitted_by: driver.id,
      notes: `Auto-generated from F1 25 telemetry — lap ${lap.lapNum}, ${lap.lapTime.toFixed(3)}s`,
    })
    .select('id, created_at')
    .single();

  if (submissionError || !submission) {
    return NextResponse.json(
      { error: `Failed to save setup submission: ${submissionError?.message ?? 'unknown error'}` },
      { status: 500 }
    );
  }

  const { data: telemetryRow, error: telemetryError } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_telemetry_uploads')
    .insert({
      submission_id: submission.id,
      driver_id: driver.id,
      track_id,
      car_class_id,
      session_uid,
      lap_num: lap.lapNum,
      lap_time_seconds: lap.lapTime,
      sector1_time_seconds: lap.sector1Time,
      sector2_time_seconds: lap.sector2Time,
      sector3_time_seconds: lap.sector3Time,
      lap_valid: lap.lapValid,
      session_type: sessionType,
      weather_code: lap.weather.weather,
      track_temperature: lap.weather.trackTemperature,
      air_temperature: lap.weather.airTemperature,
      tyre_compound: lap.tyres?.tyreCompound ?? null,
      tyre_wear_start: frames[0].tyresWear,
      tyre_wear_end: frames[frames.length - 1].tyresWear,
      tyre_surface_temp_avg: averageCorners(frames, 'tyresSurfaceTemperature'),
      tyre_inner_temp_avg: averageCorners(frames, 'tyresInnerTemperature'),
      frame_count: frames.length,
      raw_payload: lap,
    })
    .select('id')
    .maybeSingle();

  if (telemetryError) {
    console.error('telemetry-ingest: failed to archive raw telemetry (submission still saved):', telemetryError.message);
  }

  // Dynamic coaching pass — runs immediately after a valid lap lands,
  // rather than waiting for the driver to open the dashboard later. Only
  // for valid laps: an invalid lap's corner/braking data is often noisy
  // (off-track excursions, corner-cutting) and isn't representative
  // enough to feed into the season-long trend aggregates in
  // coaching-history.ts. Entirely best-effort — a failure here (LLM
  // timeout, malformed frames, whatever) must never turn a successful
  // telemetry ingest into a failed response; the driver can still get a
  // report later via the on-demand GET route, which falls back to
  // computing fresh on a cache miss.
  if (lap.lapValid) {
    try {
      const session = await getTelemetrySession(session_uid);
      if (session) {
        const currentLap = session.laps.find((l) => l.lapNum === lap.lapNum);
        if (currentLap) {
          // Auto-pick this driver's own best *other* valid lap in this
          // session as the comparison reference, so the dynamic report
          // says something like "0.3s off your best in T4" without the
          // driver having to pick a reference lap themselves. Falls back
          // to no reference (first lap of the session, or nothing else
          // valid yet) the same way the on-demand route does when the
          // caller omits reference_lap.
          const otherValidLaps = session.laps.filter((l) => l.lapNum !== lap.lapNum && l.lapValid);
          const bestOther = otherValidLaps.reduce<typeof otherValidLaps[number] | null>(
            (best, candidate) => (!best || candidate.lapTime < best.lapTime ? candidate : best),
            null
          );
          const referenceLapNum = bestOther?.lapNum ?? undefined;

          const report = await buildCoachingReport(session, lap.lapNum, referenceLapNum);
          await persistCoachingReport({
            driverId: driver.id,
            trackId: track_id,
            carClassId: car_class_id,
            sessionUid: session_uid,
            lapNum: lap.lapNum,
            referenceLapNum: referenceLapNum ?? null,
            lapTimeSeconds: lap.lapTime,
            lapValid: lap.lapValid,
            report,
          });
        }
      }
    } catch (err) {
      console.error(
        'telemetry-ingest: dynamic coaching pass failed (submission still saved, report will compute on-demand instead):',
        err instanceof Error ? err.message : err
      );
    }
  }

  return NextResponse.json(
    {
      submission: { id: submission.id, created_at: submission.created_at },
      telemetry_upload_id: telemetryRow?.id ?? null,
      resolved: { track_id, car_class_id, conditions, session_type: sessionType },
    },
    { status: 201 }
  );
}
