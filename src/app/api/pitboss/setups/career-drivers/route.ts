import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

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

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get('q')?.trim() ?? '';

  let query = supabaseAdmin
    .schema('pitboss')
    .from('career_mode_drivers')
    .select('id, driver_name, pace, racecraft, awareness, experience, focus, overall')
    .order('driver_name', { ascending: true })
    .limit(50);

  if (search) {
    query = query.ilike('driver_name', `%${search}%`);
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

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { driver_name, pace, racecraft, awareness, experience, focus } = body;

  if (!driver_name?.trim()) {
    return NextResponse.json({ error: 'driver_name is required' }, { status: 400 });
  }
  for (const [label, val] of Object.entries({ pace, racecraft, awareness, experience, focus })) {
    if (typeof val !== 'number' || val < 0 || val > 99) {
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
