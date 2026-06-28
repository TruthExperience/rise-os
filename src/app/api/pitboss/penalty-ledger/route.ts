import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const leagueId = req.nextUrl.searchParams.get('league_id')
  const driverId = req.nextUrl.searchParams.get('driver_id')
  const activeOnly = req.nextUrl.searchParams.get('active_only') === 'true'

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  let query = supabase
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

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const driverIds = [...new Set((penalties ?? []).map((p: any) => p.driver_id))]
  let drivers: any[] = []
  if (driverIds.length > 0) {
    const { data: driverData } = await supabase
      .from('drivers')
      .select('id, discord_username, display_name, discord_avatar, discord_id, pp_total, tier')
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
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { driver_id, league_id, points, reason, issued_by, expires_at } = body

  if (!driver_id || !league_id || !points || !reason || !issued_by) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  if (typeof points !== 'number' || points < 1 || points > 25) {
    return NextResponse.json({ error: 'Points must be between 1 and 25' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: penalty, error: penaltyErr } = await supabase
    .from('penalty_ledger')
    .insert({
      driver_id,
      league_id,
      points,
      reason,
      source: 'manual',
      issued_by,
      issued_at: new Date().toISOString(),
      expires_at: expires_at ?? null,
    })
    .select()
    .single()

  if (penaltyErr) {
    return NextResponse.json({ error: penaltyErr.message }, { status: 500 })
  }

  const { data: driver } = await supabase
    .from('drivers')
    .select('pp_total')
    .eq('id', driver_id)
    .single()

  const newTotal = (driver?.pp_total ?? 0) + points

  await supabase
    .from('drivers')
    .update({ pp_total: newTotal })
    .eq('id', driver_id)

  return NextResponse.json({ penalty, new_pp_total: newTotal })
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const body = await req.json()
  const { penalty_id, removed_by } = body

  if (!penalty_id || !removed_by) {
    return NextResponse.json({ error: 'penalty_id and removed_by required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: penalty, error: fetchErr } = await supabase
    .from('penalty_ledger')
    .select('id, source, points, driver_id, removed_at')
    .eq('id', penalty_id)
    .single()

  if (fetchErr || !penalty) {
    return NextResponse.json({ error: 'Penalty not found' }, { status: 404 })
  }

  if (penalty.source !== 'manual') {
    return NextResponse.json({ error: 'Cannot remove incident-linked penalties from here' }, { status: 403 })
  }

  if (penalty.removed_at) {
    return NextResponse.json({ error: 'Penalty already removed' }, { status: 409 })
  }

  const now = new Date().toISOString()

  await supabase
    .from('penalty_ledger')
    .update({ removed_at: now, removed_by })
    .eq('id', penalty_id)

  const { data: driver } = await supabase
    .from('drivers')
    .select('pp_total')
    .eq('id', penalty.driver_id)
    .single()

  const newTotal = Math.max(0, (driver?.pp_total ?? 0) - penalty.points)

  await supabase
    .from('drivers')
    .update({ pp_total: newTotal })
    .eq('id', penalty.driver_id)

  return NextResponse.json({ ok: true, new_pp_total: newTotal })
}
