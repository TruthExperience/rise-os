import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fetchParamRanges } from '@/lib/pitboss/setup-engine-data';
import { resolveDriverIdFromSession } from '@/lib/pitboss/resolveDriver';

interface SubmissionRequestBody {
  league_id?: string | null;
  car_class_id: string;
  track_id: string;
  conditions: 'dry' | 'wet' | 'mixed';
  session_type: 'race' | 'qualifying' | 'sprint' | 'time_trial' | 'practice';
  setup_values: Record<string, number>;
  notes?: string | null;
  discord_id?: string | null;
}

const DEFAULT_CONFIDENCE = 0.5;

export async function POST(req: NextRequest) {
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
    discord_id = null,
  } = body;

  if (!car_class_id || !track_id || !conditions || !session_type || !setup_values) {
    return NextResponse.json(
      { error: 'car_class_id, track_id, conditions, session_type, and setup_values are required' },
      { status: 400 }
    );
  }

  if (!discord_id) {
    return NextResponse.json({ error: 'discord_id is required to attribute a submission' }, { status: 401 });
  }
  const driver_id = await resolveDriverIdFromSession(discord_id);
  if (!driver_id) {
    return NextResponse.json({ error: 'Could not resolve driver identity' }, { status: 401 });
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
      submitted_by: driver_id,
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
