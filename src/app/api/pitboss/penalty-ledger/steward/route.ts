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

// GET — all penalties in a league (steward view)
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId  = req.nextUrl.searchParams.get('league_id')
  const driverId  = req.nextUrl.searchParams.get('driver_id')
  const activeOnly = req.nextUrl.searchParams.get('active_only') === 'true'

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    leagueId
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  let query = supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select('id, driver_id, league_id, points, reason, source, incident_id, issued_by, issued_at, expires_at, removed_at, removed_by')
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
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { driver_id, league_id, points, reason, expires_at } = body

  if (!driver_id || !league_id || !points || !reason) {
    return NextResponse.json({ error: 'driver_id, league_id, points, reason required' }, { status: 400 })
  }
  if (typeof points !== 'number' || points < 1 || points > 25) {
    return NextResponse.json({ error: 'Points must be 1–25' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

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

  // Sync pp_total
  const { data: target } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('pp_total')
    .eq('id', driver_id)
    .single()

  const newTotal = (target?.pp_total ?? 0) + points
  await supabase.schema('pitboss').from('drivers').update({ pp_total: newTotal }).eq('id', driver_id)

  return NextResponse.json({ penalty, new_pp_total: newTotal })
}

// DELETE — remove a manual penalty (steward only)
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await req.json()
  const { penalty_id, league_id } = body

  if (!penalty_id || !league_id) {
    return NextResponse.json({ error: 'penalty_id and league_id required' }, { status: 400 })
  }

  const { supabase, driver, licence } = await resolveDriverAndCheckSteward(
    session.user.discordId,
    league_id
  )

  if (!driver) return NextResponse.json({ error: 'Driver not found' }, { status: 403 })
  if (!licence) return NextResponse.json({ error: 'Steward access required' }, { status: 403 })

  const { data: penalty, error: fetchErr } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select('id, source, points, driver_id, removed_at')
    .eq('id', penalty_id)
    .single()

  if (fetchErr || !penalty) return NextResponse.json({ error: 'Penalty not found' }, { status: 404 })
  if (penalty.source !== 'manual') return NextResponse.json({ error: 'Cannot remove incident-linked penalties here' }, { status: 403 })
  if (penalty.removed_at) return NextResponse.json({ error: 'Already removed' }, { status: 409 })

  await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .update({ removed_at: new Date().toISOString(), removed_by: driver.id })
    .eq('id', penalty_id)

  const { data: target } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('pp_total')
    .eq('id', penalty.driver_id)
    .single()

  const newTotal = Math.max(0, (target?.pp_total ?? 0) - penalty.points)
  await supabase.schema('pitboss').from('drivers').update({ pp_total: newTotal }).eq('id', penalty.driver_id)

  return NextResponse.json({ ok: true, new_pp_total: newTotal })
}
