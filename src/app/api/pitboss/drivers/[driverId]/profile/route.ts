// src/app/api/pitboss/drivers/[driverId]/profile/route.ts
// Single endpoint that returns everything needed for the driver profile page.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

export async function GET(
  req: NextRequest,
  { params }: { params: { driverId: string } }
) {
  const { driverId } = params
  const leagueSlug = req.nextUrl.searchParams.get('league')

  const supabase = getSupabase()

  // ── 1. Driver core ────────────────────────────────────────────────────────
  const { data: driver, error: driverErr } = await supabase
    .from('drivers')
    .select('id, discord_id, discord_username, discord_avatar, display_name, tier, pp_total, super_licence_status, era_endorsements')
    .eq('id', driverId)
    .single()

  if (driverErr || !driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  // ── 2. League memberships ─────────────────────────────────────────────────
  const { data: driverLeagues } = await supabase
    .from('driver_leagues')
    .select('role, certified, certified_at, joined_at, league_id')
    .eq('driver_id', driverId)

  const leagueIds = driverLeagues?.map((dl: any) => dl.league_id) ?? []
  let leagues: any[] = []
  if (leagueIds.length > 0) {
    const { data: leagueData } = await supabase
      .from('leagues')
      .select('id, name, slug, sport, logo_url')
      .in('id', leagueIds)
    leagues = leagueData ?? []
  }

  const leagueMemberships = (driverLeagues ?? []).map((dl: any) => ({
    ...dl,
    league: leagues.find((l: any) => l.id === dl.league_id) ?? null,
  }))

  const filteredLeagueIds = leagueSlug
    ? leagueMemberships
        .filter((m: any) => m.league?.slug === leagueSlug)
        .map((m: any) => m.league_id)
    : leagueIds

  // ── 3. Licences ───────────────────────────────────────────────────────────
  const { data: licences } = await supabase
    .from('licences')
    .select('id, licence_number, role_code, title, tier, status, issued_at, expires_at, era_endorsements, league_id')
    .eq('driver_id', driverId)
    .in('league_id', filteredLeagueIds.length ? filteredLeagueIds : leagueIds)
    .order('issued_at', { ascending: false })

  // ── 4. Certifications ─────────────────────────────────────────────────────
  const { data: certifications } = await supabase
    .from('certifications')
    .select('id, league_id, role_code, status, score, pass_mark, attempt_number, started_at, completed_at, locked_until')
    .eq('driver_id', driverId)
    .in('league_id', filteredLeagueIds.length ? filteredLeagueIds : leagueIds)
    .order('completed_at', { ascending: false })

  // ── 5. Active contracts ───────────────────────────────────────────────────
  const { data: contracts } = await supabase
    .from('driver_contracts')
    .select('id, franchise_id, league_id, contract_class, season_start, season_end, base_salary_per_season, signing_bonus, status, special_conditions')
    .eq('driver_id', driverId)
    .eq('status', 'active')
    .in('league_id', filteredLeagueIds.length ? filteredLeagueIds : leagueIds)

  // ── 6. Race results summary ───────────────────────────────────────────────
  const { data: results } = await supabase
    .from('results')
    .select('finish_position, dnf, fastest_lap, points_earned, season, round, track')
    .eq('driver_id', driverId)
    .in('league_id', filteredLeagueIds.length ? filteredLeagueIds : leagueIds)
    .order('season', { ascending: false })

  const resultsSummary = {
    races: results?.length ?? 0,
    wins: results?.filter((r: any) => r.finish_position === 1).length ?? 0,
    podiums: results?.filter((r: any) => r.finish_position <= 3).length ?? 0,
    dnfs: results?.filter((r: any) => r.dnf).length ?? 0,
    fastest_laps: results?.filter((r: any) => r.fastest_lap).length ?? 0,
    total_points: results?.reduce((sum: number, r: any) => sum + Number(r.points_earned ?? 0), 0) ?? 0,
    recent: results?.slice(0, 5) ?? [],
  }

  // ── 7. Penalty ledger ─────────────────────────────────────────────────────
  const { data: penalties } = await supabase
    .from('penalty_ledger')
    .select('id, points, reason, issued_at, expires_at, league_id')
    .eq('driver_id', driverId)
    .in('league_id', filteredLeagueIds.length ? filteredLeagueIds : leagueIds)
    .order('issued_at', { ascending: false })

  // ── 8. Franchise info ─────────────────────────────────────────────────────
  const supabaseRise = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'rise_os' } }
  )

  const franchiseIds = (contracts ?? []).map((c: any) => c.franchise_id).filter(Boolean)
  let franchises: any[] = []
  if (franchiseIds.length > 0) {
    const { data: franchiseData } = await supabaseRise
      .from('franchises')
      .select('id, name, abbreviation, primary_color, secondary_color, logo_url')
      .in('id', franchiseIds)
    franchises = franchiseData ?? []
  }

  const contractsWithFranchise = (contracts ?? []).map((c: any) => ({
    ...c,
    franchise: franchises.find((f: any) => f.id === c.franchise_id) ?? null,
  }))

  return NextResponse.json({
    driver,
    leagues: leagueMemberships,
    licences: licences ?? [],
    certifications: certifications ?? [],
    contracts: contractsWithFranchise,
    results: resultsSummary,
    penalties: penalties ?? [],
  })
}
