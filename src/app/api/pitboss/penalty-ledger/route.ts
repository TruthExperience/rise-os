import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSession } from '@/lib/session'
import { hasLeagueRole, getDriverId } from '@/lib/pitbossAuth'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}


// expires_at must be a real future-or-past ISO date or absent; reason is capped.
function validPenaltyText(reason: unknown, expires_at: unknown): string | null {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
    return 'reason must be text up to 1000 characters'
  }
  if (expires_at != null && (typeof expires_at !== 'string' || Number.isNaN(new Date(expires_at).getTime()))) {
    return 'expires_at must be a valid date'
  }
  return null
}

// ── GET ───────────────────────────────────────────────────────────────────────
// Read access: any authenticated league member can view penalties (matches the
// existing "penalty_ledger: members can view" RLS intent). Stewards/commissioners
// implicitly qualify too since has_league_role('driver', ...) includes them.
export async function GET(req: NextRequest) {
  const leagueId = req.nextUrl.searchParams.get('league_id')
  const driverId = req.nextUrl.searchParams.get('driver_id')
  const activeOnly = req.nextUrl.searchParams.get('active_only') === 'true'

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const session = await getSession()
  const isMember = await hasLeagueRole(session, leagueId, 'driver')
  if (!isMember) {
    return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 })
  }

  const supabase = getSupabase()

  let query = supabase
    .from('penalty_ledger')
    .select('id, driver_id, league_id, points, reason, source, incident_id, issued_by, issued_at, expires_at, removed_at, removed_by, penalty_type, time_penalty_seconds, time_label, grid_places, grid_back, applies_season, applies_round')
    .eq('league_id', leagueId)
    .order('issued_at', { ascending: false })

  if (driverId) query = query.eq('driver_id', driverId)
  if (activeOnly) {
    query = query
      .is('removed_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
  }

  const { data: penalties, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const driverIds = [...new Set((penalties ?? []).map((p: any) => p.driver_id))]
  let drivers: any[] = []
  if (driverIds.length > 0) {
    const { data: driverData } = await supabase
      .from('drivers')
      .select('id, discord_username, display_name, discord_avatar, pp_total, tier')
      .in('id', driverIds)
    drivers = driverData ?? []
  }

  const driverMap = Object.fromEntries(drivers.map((d: any) => [d.id, d]))

  const enriched = (penalties ?? []).map((p: any) => ({
    ...p,
    driver: driverMap[p.driver_id] ?? null,
    is_active: !p.removed_at && (!p.expires_at || new Date(p.expires_at) > new Date()),
  }))

  return NextResponse.json({ penalties: enriched })
}

// ── POST ──────────────────────────────────────────────────────────────────────
// Write access: steward or above only. issued_by is derived from the verified
// session — never trusted from the request body — so a penalty can't be
// attributed to someone other than whoever is actually signed in.
export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { driver_id, league_id, points, reason, expires_at } = body ?? {}

  if (!driver_id || !league_id || !points || !reason) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  if (typeof points !== 'number' || !Number.isInteger(points) || points < 1 || points > 25) {
    return NextResponse.json({ error: 'Points must be a whole number between 1 and 25' }, { status: 400 })
  }
  const textError = validPenaltyText(reason, expires_at)
  if (textError) {
    return NextResponse.json({ error: textError }, { status: 400 })
  }

  const session = await getSession()
  const isSteward = await hasLeagueRole(session, league_id, 'steward')
  if (!isSteward) {
    return NextResponse.json({ error: 'Forbidden — steward role required' }, { status: 403 })
  }

  const issuedBy = await getDriverId(session)
  if (!issuedBy) {
    return NextResponse.json({ error: 'No driver profile found for signed-in user' }, { status: 400 })
  }

  const supabase = getSupabase()

  // The penalised driver must belong to this league.
  const { data: targetMember } = await supabase
    .from('driver_leagues')
    .select('driver_id')
    .eq('driver_id', driver_id)
    .eq('league_id', league_id)
    .limit(1)
  if (!targetMember?.length) {
    return NextResponse.json({ error: 'That driver is not a member of this league' }, { status: 400 })
  }

  const { data: penalty, error: penaltyErr } = await supabase
    .from('penalty_ledger')
    .insert({
      driver_id,
      league_id,
      points,
      reason,
      source: 'manual',
      issued_by: issuedBy,
      issued_at: new Date().toISOString(),
      expires_at: expires_at ?? null,
    })
    .select()
    .single()

  if (penaltyErr) {
    return NextResponse.json({ error: penaltyErr.message }, { status: 500 })
  }

  // pp_total is maintained by the trg_penalty_ledger_pp_total trigger, which
  // recalculates it from the ledger on every insert/update/delete. Adding the
  // points here as well counted every manual penalty twice. Just read it back.
  const { data: driver } = await supabase
    .from('drivers')
    .select('pp_total')
    .eq('id', driver_id)
    .single()
  const newTotal = driver?.pp_total ?? 0

  return NextResponse.json({ penalty, new_pp_total: newTotal })
}

// ── DELETE ────────────────────────────────────────────────────────────────────
// Write access: steward or above only, scoped to the penalty's own league —
// removed_by is derived from the verified session, same as issued_by above.
export async function DELETE(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { penalty_id } = body ?? {}

  if (!penalty_id) {
    return NextResponse.json({ error: 'penalty_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: penalty, error: fetchErr } = await supabase
    .from('penalty_ledger')
    .select('id, source, points, driver_id, league_id, removed_at')
    .eq('id', penalty_id)
    .single()

  if (fetchErr || !penalty) {
    return NextResponse.json({ error: 'Penalty not found' }, { status: 404 })
  }

  const session = await getSession()
  const isSteward = await hasLeagueRole(session, penalty.league_id, 'steward')
  if (!isSteward) {
    return NextResponse.json({ error: 'Forbidden — steward role required' }, { status: 403 })
  }

  const removedBy = await getDriverId(session)
  if (!removedBy) {
    return NextResponse.json({ error: 'No driver profile found for signed-in user' }, { status: 400 })
  }

  if (penalty.source !== 'manual') {
    return NextResponse.json({ error: 'Cannot remove incident-linked penalties from here' }, { status: 403 })
  }

  if (penalty.removed_at) {
    return NextResponse.json({ error: 'Penalty already removed' }, { status: 409 })
  }

  const now = new Date().toISOString()

  // Only the request that finds it still un-removed wins (double-click safe).
  const { data: removedRow } = await supabase
    .from('penalty_ledger')
    .update({ removed_at: now, removed_by: removedBy })
    .eq('id', penalty_id)
    .is('removed_at', null)
    .select('id')
    .maybeSingle()
  if (!removedRow) {
    return NextResponse.json({ error: 'Penalty already removed' }, { status: 409 })
  }

  // pp_total is recalculated by the ledger trigger; don't subtract again here.
  const { data: driver } = await supabase
    .from('drivers')
    .select('pp_total')
    .eq('id', penalty.driver_id)
    .single()
  const newTotal = driver?.pp_total ?? 0

  return NextResponse.json({ ok: true, new_pp_total: newTotal })
}
