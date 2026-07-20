import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF']

async function resolveDriverAndCheckSteward(discordId: string, leagueId: string) {
  const supabase = createAdminClient()

  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .single()

  if (!driver) return { supabase, driver: null, licence: null }

  const { data: licence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLES)
    .limit(1)
    .single()

  return { supabase, driver, licence }
}

// GET — results for a league, filterable by season/round
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const season   = req.nextUrl.searchParams.get('season')
  const round    = req.nextUrl.searchParams.get('round')

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { data: league, error: leagueError } = await supabase
    .schema('pitboss')
    .from('leagues')
    .select('name, logo_url')
    .eq('id', leagueId)
    .single()

  if (leagueError || !league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 })
  }

  let query = supabase
    .schema('pitboss')
    .from('results')
    .select(`
      id, driver_id, season, round, track,
      qualifying_position, finish_position,
      dnf, dnf_reason, fastest_lap,
      points_earned, penalty_points_added,
      sprint_qualifying_position, sprint_finish_position,
      sprint_dnf, sprint_fastest_lap, sprint_points_earned,
      created_at, round_id
    `)
    .eq('league_id', leagueId)
    .order('finish_position', { ascending: true })

  if (season) query = query.eq('season', season)
  if (round)  query = query.eq('round', parseInt(round))

  const { data: results, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich with driver info
  const driverIds = [...new Set((results ?? []).map((r: any) => r.driver_id))]
  let drivers: any[] = []
  if (driverIds.length > 0) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_username, display_name, tier')
      .in('id', driverIds)
    drivers = data ?? []
  }

  const driverMap = Object.fromEntries(drivers.map((d: any) => [d.id, d]))
  const enriched = (results ?? []).map((r: any) => ({
    ...r,
    driver: driverMap[r.driver_id] ?? null,
  }))

  return NextResponse.json({
    league_name: league.name,
    league_logo_url: league.logo_url,
    results: enriched,
  })
}

// POST — bulk insert results for a round (steward only)
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { league_id, rows } = body

  if (!league_id || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'league_id and rows[] required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  const inserts = rows.map((r: any) => ({
    league_id,
    driver_id:                  r.driver_id,
    season:                     r.season,
    round:                      r.round,
    round_id:                   r.round_id ?? null,
    track:                      r.track ?? null,
    qualifying_position:        r.qualifying_position ?? null,
    finish_position:            r.finish_position ?? null,
    dnf:                        r.dnf ?? false,
    dnf_reason:                 r.dnf_reason ?? null,
    fastest_lap:                r.fastest_lap ?? false,
    points_earned:              r.points_earned ?? 0,
    penalty_points_added:       r.penalty_points_added ?? 0,
    sprint_qualifying_position: r.sprint_qualifying_position ?? null,
    sprint_finish_position:     r.sprint_finish_position ?? null,
    sprint_dnf:                 r.sprint_dnf ?? false,
    sprint_fastest_lap:         r.sprint_fastest_lap ?? false,
    sprint_points_earned:       r.sprint_points_earned ?? 0,
  }))

  const { data, error } = await supabase
    .schema('pitboss')
    .from('results')
    .insert(inserts)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { error: recomputeError } = await supabase.schema('pitboss').rpc('recompute_driver_standings')
  if (recomputeError) {
    return NextResponse.json(
      { results: data, warning: `Results saved, but standings recompute failed: ${recomputeError.message}` },
      { status: 201 }
    )
  }

  return NextResponse.json({ results: data }, { status: 201 })
}

// PUT — edit a single result
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { result_id, league_id, ...updates } = body

  if (!result_id || !league_id) {
    return NextResponse.json({ error: 'result_id and league_id required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  const allowed = [
    'finish_position', 'qualifying_position', 'dnf', 'dnf_reason',
    'fastest_lap', 'points_earned', 'penalty_points_added', 'track',
    'sprint_qualifying_position', 'sprint_finish_position',
    'sprint_dnf', 'sprint_fastest_lap', 'sprint_points_earned',
  ]
  const patch = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  const { data, error } = await supabase
    .schema('pitboss')
    .from('results')
    .update(patch)
    .eq('id', result_id)
    .eq('league_id', league_id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { error: recomputeError } = await supabase.schema('pitboss').rpc('recompute_driver_standings')
  if (recomputeError) {
    return NextResponse.json(
      { result: data, warning: `Result updated, but standings recompute failed: ${recomputeError.message}` }
    )
  }

  return NextResponse.json({ result: data })
}
