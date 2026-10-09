import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
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


const NUMERIC_FIELDS = [
  'round', 'qualifying_position', 'finish_position', 'points_earned', 'penalty_points_added',
  'sprint_qualifying_position', 'sprint_finish_position', 'sprint_points_earned',
]

// Returns an error message, or null when the row is acceptable. `partial` is
// true for edits, where driver_id/season/round need not be present.
function checkResultRow(r: any, partial = false): string | null {
  if (!r || typeof r !== 'object') return 'Each row must be an object'
  if (!partial) {
    if (typeof r.driver_id !== 'string' || !r.driver_id) return 'Each row needs a driver_id'
    if (r.season == null || r.season === '') return 'Each row needs a season'
    if (r.round == null || !Number.isInteger(Number(r.round))) return 'Each row needs a whole-number round'
  }
  for (const f of NUMERIC_FIELDS) {
    const v = r[f]
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000)) {
      return `${f} must be a number between 0 and 1000`
    }
  }
  for (const f of ['dnf_reason', 'track']) {
    if (r[f] != null && (typeof r[f] !== 'string' || r[f].length > 200)) return `${f} must be text under 200 characters`
  }
  return null
}

// GET — results for a league, filterable by season/round
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const season   = req.nextUrl.searchParams.get('season')
  const round    = req.nextUrl.searchParams.get('round')

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }
  if (round != null && !Number.isInteger(Number(round))) {
    return NextResponse.json({ error: 'round must be a whole number' }, { status: 400 })
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
  const session = await getSession()
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { league_id, rows } = body ?? {}

  if (!league_id || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'league_id and rows[] required' }, { status: 400 })
  }
  if (rows.length > 100) {
    return NextResponse.json({ error: 'At most 100 rows per request' }, { status: 400 })
  }
  const rowError = rows.map((row: any) => checkResultRow(row)).find(Boolean)
  if (rowError) {
    return NextResponse.json({ error: rowError }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  // Every driver in the batch must belong to this league.
  const rowDriverIds = [...new Set(rows.map((r: any) => r.driver_id))] as string[]
  const { data: leagueMembers } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('driver_id')
    .eq('league_id', league_id)
    .in('driver_id', rowDriverIds)
  const memberSet = new Set((leagueMembers ?? []).map((m: any) => m.driver_id))
  const outsider = rowDriverIds.find((id) => !memberSet.has(id))
  if (outsider) {
    return NextResponse.json({ error: `Driver ${outsider} is not a member of this league` }, { status: 400 })
  }

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
  const session = await getSession()
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { result_id, league_id, ...updates } = body ?? {}

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

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 })
  }
  const patchError = checkResultRow(patch, true)
  if (patchError) {
    return NextResponse.json({ error: patchError }, { status: 400 })
  }

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
