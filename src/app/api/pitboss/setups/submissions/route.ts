import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';

export const dynamic = 'force-dynamic';

const CONDITIONS = ['dry', 'wet', 'mixed'] as const;
const SESSION_TYPES = ['race', 'qualifying', 'sprint', 'time_trial', 'practice'] as const;
const MAX_NOTES_LENGTH = 1000;

interface SubmissionRequestBody {
  league_id?: string | null;
  car_class_id: string;
  track_id: string;
  conditions: (typeof CONDITIONS)[number];
  session_type: (typeof SESSION_TYPES)[number];
  setup_values: Record<string, number>;
  notes?: string | null;
  discord_id?: string | null; // ignored — identity comes from the signed-in driver
}

const DEFAULT_CONFIDENCE = 0.5;

export async function POST(req: NextRequest) {
  // submitted_by comes from the signed-in driver, never from the request body.
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseAdmin = createAdminClient();
  let body: SubmissionRequestBody;
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
    setup_values,
    notes = null,
  } = body ?? ({} as SubmissionRequestBody);
  if (!car_class_id || !track_id || !conditions || !session_type || !setup_values) {
    return NextResponse.json(
      { error: 'car_class_id, track_id, conditions, session_type, and setup_values are required' },
      { status: 400 }
    );
  }
  if (!CONDITIONS.includes(conditions)) {
    return NextResponse.json({ error: `conditions must be one of: ${CONDITIONS.join(', ')}` }, { status: 400 });
  }
  if (!SESSION_TYPES.includes(session_type)) {
    return NextResponse.json({ error: `session_type must be one of: ${SESSION_TYPES.join(', ')}` }, { status: 400 });
  }
  if (typeof setup_values !== 'object' || Array.isArray(setup_values)) {
    return NextResponse.json({ error: 'setup_values must be an object' }, { status: 400 });
  }
  if (notes !== null && (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH)) {
    return NextResponse.json(
      { error: `notes must be a string of ${MAX_NOTES_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }

  // A submission tagged with a league must come from a member of that league.
  if (league_id) {
    const { data: membership } = await supabaseAdmin
      .schema('pitboss')
      .from('driver_leagues')
      .select('driver_id')
      .eq('driver_id', driver.id)
      .eq('league_id', league_id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: 'You are not a member of this league' }, { status: 403 });
    }
  }

  let ranges;
  try {
    ranges = await fetchParamRanges(car_class_id, session_type);
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
  const rangeByKey = Object.fromEntries(ranges.map((r) => [r.param_key, r]));
  const submittedKeys = Object.keys(setup_values);
  const validKeys = new Set(Object.keys(rangeByKey));
  const unknownKeys = submittedKeys.filter((k) => !validKeys.has(k));
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      { error: `Unknown setup parameter(s) for this car class: ${unknownKeys.join(', ')}` },
      { status: 400 }
    );
  }
  const outOfRange: string[] = [];
  for (const [key, value] of Object.entries(setup_values)) {
    const range = rangeByKey[key];
    if (typeof value !== 'number' || Number.isNaN(value) || value < range.min_value || value > range.max_value) {
      outOfRange.push(key);
    }
  }
  if (outOfRange.length > 0) {
    return NextResponse.json(
      { error: `Setup value(s) out of range for this car class: ${outOfRange.join(', ')}` },
      { status: 400 }
    );
  }
  const missingKeys = ranges.map((r) => r.param_key).filter((k) => !(k in setup_values));
  if (missingKeys.length > 0) {
    return NextResponse.json(
      { error: `Missing setup value(s) for this car class / session type: ${missingKeys.join(', ')}` },
      { status: 400 }
    );
  }
  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_submissions')
    .insert({
      league_id,
      car_class_id,
      track_id,
      conditions,
      session_type,
      setup_values,
      source: 'driver',
      source_name: null,
      source_url: null,
      confidence: DEFAULT_CONFIDENCE,
      verified: false,
      submitted_by: driver.id,
      notes,
    })
    .select('id, created_at')
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: `Failed to save setup submission: ${error?.message ?? 'unknown error'}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ submission: data }, { status: 201 });
}
