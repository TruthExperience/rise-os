// FILE: src/app/api/pitboss/results/route.ts   (replace the whole file)
import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver, getSupabaseUserId } from '@/lib/getSupabaseUserId'
import { createAdminClient } from '@/lib/supabase/server'
import { applyPositionDrop } from '@/lib/pitboss/applyResultPenalty'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF']

async function resolveDriverAndCheckSteward(driverId: string, leagueId: string) {
  const supabase = createAdminClient()
  const driver = { id: driverId }

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


// A guilty ruling can be made before the round's results are entered. When
// the results arrive, apply any position drops that are still waiting. Each
// incident is applied at most once (active adjustments are skipped). Standings
// are NOT recomputed here; the caller does that once for the whole request.
async function applyPendingPositionDrops(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  rows: any[]
): Promise<{ applied: number; notes: string[] }> {
  const rounds = new Map<string, { season: string; round: number }>()
  for (const r of rows) {
    rounds.set(`${r.season}|${r.round}`, { season: String(r.season), round: Number(r.round) })
  }

  let applied = 0
  const notes: string[] = []
  for (const { season, round } of rounds.values()) {
    const { data: incidents } = await supabase
      .schema('pitboss')
      .from('incidents')
      .select('id, league_id, season, round, accused_driver_id, position_drop')
      .eq('league_id', leagueId)
      .eq('season', season)
      .eq('round', round)
      .eq('status', 'resolved')
      .eq('verdict', 'guilty')
      .gt('position_drop', 0)

    for (const inc of incidents ?? []) {
      const { data: active } = await supabase
        .schema('pitboss')
        .from('result_adjustments')
        .select('id')
        .eq('incident_id', inc.id)
        .is('reverted_at', null)
        .limit(1)
      if (active && active.length > 0) continue

      const outcome = await applyPositionDrop(supabase, inc, inc.position_drop, { recompute: false })
      if (outcome.applied) applied++
      if (outcome.note) notes.push(outcome.note)
    }
  }
  return { applied, notes }
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
  // Any signed-in account may read results (email sign-ups included).
  const userId = await getSupabaseUserId()
  if (!userId) {
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

  // Seasons that actually have results for this league (newest first). When the
  // caller doesn't ask for a season, default to the latest one rather than a
  // hard-coded year — season is a free-text label ('1', '2', '2026', ...).
  const { data: seasonRows } = await supabase
    .schema('pitboss')
    .from('results')
    .select('season')
    .eq('league_id', leagueId)
    .limit(5000)

  const seasons = [...new Set((seasonRows ?? []).map((r: any) => String(r.season)))]
    .sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isNaN(na) || Number.isNaN(nb)) return b.localeCompare(a)
      return nb - na
    })
  const activeSeason = season || seasons[0] || null

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

  if (activeSeason) query = query.eq('season', activeSeason)
  if (round)        query = query.eq('round', parseInt(round))

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
    season: activeSeason,
    seasons,
    results: enriched,
  })
}

// POST — bulk insert results for a round (steward only)
export async function POST(req: NextRequest) {
  const authed = await getAuthedDriver()
  if (!authed) {
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
    authed.id,
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

  // Rulings made before these results existed may carry a position drop.
  // A failure here never undoes the saved results; it comes back as a note.
  let pending: { applied: number; notes: string[] } = { applied: 0, notes: [] }
  try {
    pending = await applyPendingPositionDrops(supabase, league_id, inserts)
  } catch (err) {
    console.error('[results POST] pending position drops', err)
    pending.notes.push("Results saved, but waiting position drops couldn't be applied. Check the round's penalties.")
  }

  // One recompute for the whole request. It covers every league.
  const { error: recomputeError } = await supabase.schema('pitboss').rpc('recompute_driver_standings')

  // If a drop moved rows, send back the current values, not the inserted ones.
  let responseRows = data
  if (pending.applied > 0 && data?.length) {
    const { data: fresh } = await supabase
      .schema('pitboss')
      .from('results')
      .select('*')
      .in('id', data.map((r: any) => r.id))
    if (fresh) responseRows = fresh
  }

  const warnings: string[] = []
  if (recomputeError) warnings.push(`Results saved, but standings recompute failed: ${recomputeError.message}`)
  warnings.push(...pending.notes)

  return NextResponse.json(
    { results: responseRows, ...(warnings.length ? { warning: warnings.join(' ') } : {}) },
    { status: 201 }
  )
}

// PUT — edit a single result
export async function PUT(req: NextRequest) {
  const authed = await getAuthedDriver()
  if (!authed) {
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
    authed.id,
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
