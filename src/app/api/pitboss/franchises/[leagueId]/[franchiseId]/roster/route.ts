import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { leagueId: string; franchiseId: string } }
) {
  const { leagueId, franchiseId } = params;

  if (!leagueId || !franchiseId) {
    return NextResponse.json(
      { error: 'leagueId and franchiseId are required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('driver_contracts')
    .select(
      `
      id,
      contract_class,
      status,
      season_start,
      season_end,
      driver:drivers (
        id,
        discord_id,
        display_name,
        discord_username,
        discord_avatar,
        tier,
        pp_total,
        super_licence_status,
        era_endorsements
      )
      `
    )
    .eq('league_id', leagueId)
    .eq('franchise_id', franchiseId)
    .eq('status', 'active')
    .order('contract_class', { ascending: true });

  if (error) {
    console.error('[pitboss roster] Supabase query error:', error.message);
    return NextResponse.json({ error: 'Failed to load roster' }, { status: 500 });
  }

  const roster = (data ?? []).map((contract: any) => ({
    contractId: contract.id,
    contractClass: contract.contract_class,
    seasonStart: contract.season_start,
    seasonEnd: contract.season_end,
    driver: contract.driver,
  }));

  return NextResponse.json(
    { leagueId, franchiseId, count: roster.length, roster },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } }
  );
}
