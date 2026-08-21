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

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';
import type { SessionType } from '@/lib/pitboss/setup-engine';

export const dynamic = 'force-dynamic';

const DEFAULT_CAR_CLASS_CODE = 'F1_2025';
const TELEMETRY_CONFIDENCE = 0.85;

// F1 game weather enum: 0 clear, 1 light cloud, 2 overcast, 3 light rain,
// 4 heavy rain, 5 storm. Mapped to the engine's dry/wet/mixed conditions.
function conditionsFromWeatherCode(code: number): 'dry' | 'wet' | 'mixed' {
  if (code <= 2) return 'dry';
  if (code === 3) return 'mixed';
  return 'wet';
}

// True if the tyre compound string indicates an F2 car (e.g.
// "f2SuperSoft"). Used to disambiguate sessionType, not currently used
// for car_class_code resolution (that stays caller-supplied per the file
// header — this is a narrower, session-type-only signal check).
function isF2Compound(tyreCompound: string | undefined | null): boolean {
  return typeof tyreCompound === 'string' && tyreCompound.toLowerCase().startsWith('f2');
}

// Maps whatever raw sessionType string P1 sends into our canonical
// SessionType, disambiguating "race2" (and "race1") by category per the
// file header. Returns null for anything unrecognized so the caller can
// produce a clear 400 with the original raw value.
function resolveSessionType(rawSessionType: string, tyreCompound: string | undefined | null): SessionType | null {
  switch (rawSessionType) {
    case 'race1':
      // F2 and F1-sprint-weekend both use race1 = sprint. See the file
      // header's OPEN QUESTION for the unconfirmed standard-F1-weekend
      // case.
      return 'sprint';
    case 'race2':
      // F2: feature race. F1 (only appears on a sprint weekend): Grand
      // Prix. Either way it's our plain "race" SessionType.
      return 'race';
    case 'race':
    case 'race3':
      // Bare "race" (no race2 sent) is a standard F1 weekend's only race.
      // race3 isn't currently produced by either category on payloads
      // seen so far, but maps to "race" rather than being rejected.
      return 'race';
    case 'qualifying':
    case 'qualifying1':
    case 'qualifying2':
    case 'qualifying3':
    case 'q1':
    case 'q2':
    case 'q3':
    case 'shortq':
    case 'osq':
      return 'qualifying';
    case 'sprint':
    case 'sprintqualifying':
      return 'sprint';
    case 'time_trial':
    case 'timetrial':
      return 'time_trial';
    case 'practice':
    case 'practice1':
    case 'practice2':
    case 'practice3':
    case 'p1':
    case 'p2':
    case 'p3':
    case 'shortp':
      return 'practice';
    default:
      return null;
  }
}

// carSetup (nested by category) -> flat param_key, matching
// pitboss.setup_parameter_ranges exactly. fuel_load has no telemetry
// counterpart (it's a strategy input, not a car setup param) and is
// intentionally omitted here.
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

// [FL, FR, RL, RR] average across every frame, per corner.
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
  // Only populated for multipart uploads — sibling form fields sent next
  // to the file (see TelemetryUploadPage's handleFileSubmit). Undefined
  // for raw/wrapped JSON POSTs, where these live inside the JSON itself
  // instead.
  formCarClassCode?: string;
  formLeagueId?: string;
}

// Reads and JSON-parses the request body regardless of how it was sent:
// a raw application/json POST, or a multipart/form-data upload with a
// .json file attached under any field name (browser file input, curl -F,
// etc. all vary in what they name the field, so the first File found on
// the form is used rather than requiring a specific field name) plus
// optional car_class_code / league_id sibling fields.
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

  // Default: raw JSON body (Content-Type: application/json, or no
  // content-type header at all — some tools omit it for raw JSON POSTs).
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

  // The capture tool posts/uploads the lap object directly at the top
  // level (identified by a top-level lapNum, which only the raw lap shape
  // has). Some callers may still send the wrapped { telemetry,
  // car_class_code, league_id } shape — support both rather than forcing
  // every caller to match one specific envelope.
  //
  // For multipart uploads, car_class_code/league_id never live inside the
  // file's JSON (the file is just the raw lap capture) — they come from
  // the sibling form fields instead, falling back to the wrapped-body
  // fields for non-multipart wrapped requests, then to defaults.
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

  // Track resolution by name — see file header for why not by numeric id.
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

  // Validate the mapped setup against this car class's actual param ranges
  // — same guardrail the manual /submissions route applies, so a telemetry
  // upload can't silently insert an out-of-range or unrecognized value.
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

  // Archive the raw lap — best-effort. A failure here shouldn't roll back
  // the submission that already landed; the submission is the part the
  // engine actually depends on.
  const frames = lap.telemetry;
  const { data: telemetryRow, error: telemetryError } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_telemetry_uploads')
    .insert({
      submission_id: submission.id,
      driver_id: driver.id,
      track_id,
      car_class_id,
      session_uid: String(lap.sessionUID),
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

  return NextResponse.json(
    {
      submission: { id: submission.id, created_at: submission.created_at },
      telemetry_upload_id: telemetryRow?.id ?? null,
      resolved: { track_id, car_class_id, conditions, session_type: sessionType },
    },
    { status: 201 }
  );
}
