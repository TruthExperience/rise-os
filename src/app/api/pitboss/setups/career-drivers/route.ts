import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getAuthedDriver } from '@/lib/getSupabaseUserId';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 80;

// Pace weighted heaviest, mirroring EA's F1 25 Driver Career overall calc.
// Focus added at .1, matching the weighting previously used client-side in
// CareerDriverRatingsCard's live preview before that component was replaced.
function computeOverall(
  pace: number,
  racecraft: number,
  awareness: number,
  experience: number,
  focus: number
): number {
  const weighted =
    pace * 0.35 + racecraft * 0.2 + awareness * 0.2 + experience * 0.15 + focus * 0.1;
  return Math.round(weighted);
}

// GET stays public: it is a read-only, searchable library of ratings.
export async function GET(req: NextRequest) {
  const supabaseAdmin = createAdminClient();
  const search = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  let query = supabaseAdmin
    .schema('pitboss')
    .from('career_mode_drivers')
    .select('id, driver_name, pace, racecraft, awareness, experience, focus, overall')
    .order('driver_name', { ascending: true })
    .limit(50);
  if (search) {
    // Strip characters that have meaning in LIKE patterns so a search for
    // "%" or "_" can't turn into a wildcard scan.
    const safe = search.slice(0, MAX_NAME_LENGTH).replace(/[%_\\]/g, ' ').trim();
    if (safe) query = query.ilike('driver_name', `%${safe}%`);
  }
  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ career_drivers: data ?? [] });
}

interface CreateBody {
  driver_name: string;
  pace: number;
  racecraft: number;
  awareness: number;
  experience: number;
  focus: number;
}

// POST needs a signed-in driver. Any signed-in driver can add an entry to the
// shared library, which is what the setups page does today.
export async function POST(req: NextRequest) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseAdmin = createAdminClient();
  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { driver_name, pace, racecraft, awareness, experience, focus } = body ?? ({} as CreateBody);
  if (typeof driver_name !== 'string' || !driver_name.trim()) {
    return NextResponse.json({ error: 'driver_name is required' }, { status: 400 });
  }
  if (driver_name.trim().length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `driver_name must be ${MAX_NAME_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }
  for (const [label, val] of Object.entries({ pace, racecraft, awareness, experience, focus })) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 99) {
      return NextResponse.json({ error: `${label} must be a number between 0 and 99` }, { status: 400 });
    }
  }
  const overall = computeOverall(pace, racecraft, awareness, experience, focus);
  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('career_mode_drivers')
    .insert({ driver_name: driver_name.trim(), pace, racecraft, awareness, experience, focus, overall })
    .select('id, driver_name, pace, racecraft, awareness, experience, focus, overall')
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create career driver' }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}
