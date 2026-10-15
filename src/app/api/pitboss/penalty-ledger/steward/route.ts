import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { createAdminClient } from '@/lib/supabase/server'

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

// GET — all penalties in a league (steward view)
export async function GET(req: NextRequest) {
  const authed = await getAuthedDriver()
  if (!authed) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId  = req.nextUrl.searchParams.get('league_id')
  const driverId  = req.nextUrl.searchParams.get('driver_id')
  const activeOnly = req.nextUrl.searchParams.get('active_only') === 'true'

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    authed.id,
    leagueId
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  let query = supabase
    .schema('pitboss')
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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich with driver info
  const driverIds = [...new Set((penalties ?? []).map((p: any) => p.driver_id))]
  let drivers: any[] = []
  if (driverIds.length > 0) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_username, display_name, discord_avatar, pp_total, tier')
      .in('id', driverIds)
    drivers = data ?? []
  }

  const driverMap = Object.fromEntries(drivers.map((d: any) => [d.id, d]))
  const enriched = (penalties ?? []).map((p: any) => ({
    ...p,
    driver: driverMap[p.driver_id] ?? null,
    is_active: !p.removed_at && (!p.expires_at || new Date(p.expires_at) > new Date()),
  }))

  return NextResponse.json({ penalties: enriched })
}

// POST — issue manual penalty (steward only)
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
  const { driver_id, league_id, points, reason, expires_at } = body ?? {}

  if (!driver_id || !league_id || !points || !reason) {
    return NextResponse.json({ error: 'driver_id, league_id, points, reason required' }, { status: 400 })
  }
  if (typeof points !== 'number' || !Number.isInteger(points) || points < 1 || points > 25) {
    return NextResponse.json({ error: 'Points must be a whole number from 1 to 25' }, { status: 400 })
  }
  const textError = validPenaltyText(reason, expires_at)
  if (textError) {
    return NextResponse.json({ error: textError }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    authed.id,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  // The penalised driver must belong to this league.
  const { data: targetMember } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('driver_id')
    .eq('driver_id', driver_id)
    .eq('league_id', league_id)
    .limit(1)
  if (!targetMember?.length) {
    return NextResponse.json({ error: 'That driver is not a member of this league' }, { status: 400 })
  }

  const { data: penalty, error: penaltyErr } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .insert({
      driver_id,
      league_id,
      points,
      reason,
      source: 'manual',
      issued_by: driver.id,
      issued_at: new Date().toISOString(),
      expires_at: expires_at ?? null,
    })
    .select()
    .single()

  if (penaltyErr) return NextResponse.json({ error: penaltyErr.message }, { status: 500 })

  // pp_total is maintained by the trg_penalty_ledger_pp_total trigger, which
  // recalculates it from the ledger on every change. The extra update here
  // counted every manual penalty twice. Just read the result back.
  const { data: target } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('pp_total')
    .eq('id', driver_id)
    .single()
  const newTotal = target?.pp_total ?? 0

  return NextResponse.json({ penalty, new_pp_total: newTotal })
}

// DELETE — remove a manual penalty (steward only)
export async function DELETE(req: NextRequest) {
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
  const { penalty_id, league_id } = body ?? {}

  if (!penalty_id || !league_id) {
    return NextResponse.json({ error: 'penalty_id and league_id required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    authed.id,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  const { data: penalty, error: fetchErr } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select('id, source, points, driver_id, removed_at')
    .eq('id', penalty_id)
    // Scope to the league the steward was verified for. Without this, a
    // steward of league A could remove a manual penalty from league B by
    // passing their own league_id with B's penalty id.
    .eq('league_id', league_id)
    .single()

  if (fetchErr || !penalty) return NextResponse.json({ error: 'Penalty not found' }, { status: 404 })
  if (penalty.source !== 'manual') return NextResponse.json({ error: 'Cannot remove incident-linked penalties here' }, { status: 403 })
  if (penalty.removed_at) return NextResponse.json({ error: 'Already removed' }, { status: 409 })

  // Only the request that finds it still un-removed wins (double-click safe).
  const { data: removedRow } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .update({ removed_at: new Date().toISOString(), removed_by: driver.id })
    .eq('id', penalty_id)
    .is('removed_at', null)
    .select('id')
    .maybeSingle()
  if (!removedRow) return NextResponse.json({ error: 'Already removed' }, { status: 409 })

  // pp_total is recalculated by the ledger trigger; don't subtract again here.
  const { data: target } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('pp_total')
    .eq('id', penalty.driver_id)
    .single()
  const newTotal = target?.pp_total ?? 0

  return NextResponse.json({ ok: true, new_pp_total: newTotal })
}
