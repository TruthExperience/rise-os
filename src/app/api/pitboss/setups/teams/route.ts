import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const carClassId = req.nextUrl.searchParams.get('car_class_id');

  if (!carClassId) {
    return NextResponse.json({ error: 'car_class_id is required' }, { status: 400 });
  }

  const { data: teams, error: teamsErr } = await supabaseAdmin
    .schema('pitboss')
    .from('car_class_teams')
    .select('id, team_name, short_name, logo_url')
    .eq('car_class_id', carClassId)
    .order('team_name');

  if (teamsErr) {
    return NextResponse.json({ error: teamsErr.message }, { status: 500 });
  }

  const teamIds = (teams ?? []).map((t) => t.id);

  const { data: drivers, error: driversErr } = teamIds.length
    ? await supabaseAdmin
        .schema('pitboss')
        .from('car_class_team_drivers')
        .select('id, team_id, driver_name, car_number')
        .in('team_id', teamIds)
        .order('driver_name')
    : { data: [], error: null };

  if (driversErr) {
    return NextResponse.json({ error: driversErr.message }, { status: 500 });
  }

  const result = (teams ?? []).map((team) => ({
    ...team,
    drivers: (drivers ?? []).filter((d) => d.team_id === team.id),
  }));

  return NextResponse.json({ teams: result }, { status: 200 });
}
