import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';
import { defaultPoints } from '@/lib/pitboss/career-tracker';

export const dynamic = 'force-dynamic';

const RESULT_COLUMNS =
  'id, career_driver_id, series, season, round, track_id, track_name, race_type, team_name, quali_position, grid_position, finish_position, dnf, fastest_lap, points, recorded_by, created_at';

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// GET stays public, like the career driver library itself. Returns the
// driver's career path plus every logged result (qualifying + race).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin = createAdminClient();

  // career_path may not exist yet if the migration hasn't been run — fall back
  // to the default rather than failing the whole request.
  let careerPath: 'f2_f1' | 'f1_only' = 'f2_f1';
  const { data: driverRow, error: driverError } = await admin
    .schema('pitboss')
    .from('career_mode_drivers')
    .select('career_path')
    .eq('id', id)
    .maybeSingle();
  if (!driverError && driverRow?.career_path === 'f1_only') careerPath = 'f1_only';

  const { data, error } = await admin
    .schema('pitboss')
    .from('career_driver_race_results')
    .select(RESULT_COLUMNS)
    .eq('career_driver_id', id)
    .order('season', { ascending: false })
    .order('round', { ascending: false })
    .limit(1000);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ career_path: careerPath, results: data ?? [] });
}

interface CreateBody {
  series: 'f1' | 'f2';
  season: number;
  round: number;
  race_type?: 'race' | 'sprint';
  track_id?: string | null;
  track_name?: string | null;
  team_name?: string | null;
  quali_position?: number | null;
  grid_position?: number | null;
  finish_position?: number | null;
  dnf?: boolean;
  fastest_lap?: boolean;
  points?: number | null;
}

// Any signed-in driver can log results, matching how stats and the library work.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const admin = createAdminClient();

  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const series = body.series;
  if (series !== 'f1' && series !== 'f2') {
    return NextResponse.json({ error: "series must be 'f1' or 'f2'" }, { status: 400 });
  }
  const raceType = body.race_type ?? 'race';
  if (raceType !== 'race' && raceType !== 'sprint') {
    return NextResponse.json({ error: "race_type must be 'race' or 'sprint'" }, { status: 400 });
  }
  if (!isIntInRange(body.season, 1, 50)) {
    return NextResponse.json({ error: 'season must be a whole number between 1 and 50' }, { status: 400 });
  }
  if (!isIntInRange(body.round, 1, 40)) {
    return NextResponse.json({ error: 'round must be a whole number between 1 and 40' }, { status: 400 });
  }
  const quali = body.quali_position ?? null;
  const grid = body.grid_position ?? null;
  const finish = body.finish_position ?? null;
  if (quali !== null && !isIntInRange(quali, 1, 30)) {
    return NextResponse.json({ error: 'quali_position must be between 1 and 30' }, { status: 400 });
  }
  if (grid !== null && !isIntInRange(grid, 1, 30)) {
    return NextResponse.json({ error: 'grid_position must be between 1 and 30' }, { status: 400 });
  }
  if (finish !== null && !isIntInRange(finish, 1, 30)) {
    return NextResponse.json({ error: 'finish_position must be between 1 and 30' }, { status: 400 });
  }
  const dnf = Boolean(body.dnf);
  const fastestLap = Boolean(body.fastest_lap);
  if (!dnf && finish === null) {
    return NextResponse.json({ error: 'Enter a finish position, or mark the race as a DNF' }, { status: 400 });
  }
  if (body.points != null && !isIntInRange(body.points, 0, 100)) {
    return NextResponse.json({ error: 'points must be a whole number between 0 and 100' }, { status: 400 });
  }
  const teamName =
    typeof body.team_name === 'string' && body.team_name.trim() ? body.team_name.trim().slice(0, 80) : null;

  // The driver must exist, and an F1-only career can't log F2 results.
  const { data: driverRow, error: driverError } = await admin
    .schema('pitboss')
    .from('career_mode_drivers')
    .select('id, career_path')
    .eq('id', id)
    .maybeSingle();
  if (driverError && !driverError.message.includes('career_path')) {
    return NextResponse.json({ error: driverError.message }, { status: 500 });
  }
  let careerPath: string = 'f2_f1';
  if (driverError) {
    // career_path column missing (migration not run) — just confirm the driver exists.
    const { data: exists } = await admin
      .schema('pitboss')
      .from('career_mode_drivers')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!exists) return NextResponse.json({ error: 'Career driver not found' }, { status: 404 });
  } else {
    if (!driverRow) return NextResponse.json({ error: 'Career driver not found' }, { status: 404 });
    careerPath = driverRow.career_path ?? 'f2_f1';
  }
  if (series === 'f2' && careerPath === 'f1_only') {
    return NextResponse.json(
      { error: 'This driver is on an F1-only career path. Switch the path to include F2 first.' },
      { status: 400 }
    );
  }

  // Resolve the track name from the tracks table when an id is given.
  let trackId: string | null = null;
  let trackName: string | null =
    typeof body.track_name === 'string' && body.track_name.trim() ? body.track_name.trim().slice(0, 80) : null;
  if (typeof body.track_id === 'string' && body.track_id) {
    const { data: track } = await admin
      .schema('pitboss')
      .from('tracks')
      .select('id, name')
      .eq('id', body.track_id)
      .maybeSingle();
    if (track) {
      trackId = track.id;
      trackName = track.name;
    }
  }

  const points =
    body.points ??
    defaultPoints({ series, raceType, finish: dnf ? null : finish, dnf, fastestLap, quali });

  const { data, error } = await admin
    .schema('pitboss')
    .from('career_driver_race_results')
    .insert({
      career_driver_id: id,
      series,
      season: body.season,
      round: body.round,
      race_type: raceType,
      track_id: trackId,
      track_name: trackName,
      team_name: teamName,
      quali_position: quali,
      grid_position: grid,
      finish_position: dnf ? null : finish,
      dnf,
      fastest_lap: fastestLap,
      points,
      recorded_by: driver.id,
    })
    .select(RESULT_COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `That ${raceType === 'sprint' ? 'sprint' : 'race'} is already logged for this season and round. Delete it first to re-enter.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error?.message ?? 'Failed to save result' }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}
