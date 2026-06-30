import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { leagueId: string } }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const driverId = searchParams.get('driver_id')

  let query = supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select(`
      *,
      driver:drivers(id, display_name, discord_username),
      incident:incidents(id, incident_type, status, round),
      issued_by_driver:drivers!penalty_ledger_issued_by_fkey(id, display_name)
    `)
    .eq('league_id', params.leagueId)
    .order('issued_at', { ascending: false })

  if (driverId) query = query.eq('driver_id', driverId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

export async function POST(
  req: NextRequest,
  { params }: { params: { leagueId: string } }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify steward/commissioner role
  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('is_head_steward, is_commissioner, is_co_owner')
    .eq('league_id', params.leagueId)
    .maybeSingle()

  if (!membership?.is_head_steward && !membership?.is_commissioner && !membership?.is_co_owner) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { driver_id, points, reason, incident_id, round_id, expires_at } = body

  if (!driver_id || !points || !reason) {
    return NextResponse.json({ error: 'driver_id, points, reason required' }, { status: 400 })
  }

  // Resolve issuer's driver_id from auth user
  const { data: issuerDriver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', user.user_metadata?.provider_id ?? user.id)
    .maybeSingle()

  const { data, error } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .insert({
      league_id: params.leagueId,
      driver_id,
      points,
      reason,
      incident_id: incident_id ?? null,
      round_id: round_id ?? null,
      expires_at: expires_at ?? null,
      source: incident_id ? 'incident' : 'manual',
      issued_by: issuerDriver?.id ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
