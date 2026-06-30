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
  const season = searchParams.get('season')
  const round = searchParams.get('round')
  const roundId = searchParams.get('round_id')

  let query = supabase
    .schema('pitboss')
    .from('results')
    .select(`
      *,
      driver:drivers(id, display_name, discord_username, tier)
    `)
    .eq('league_id', params.leagueId)
    .order('finish_position', { ascending: true })

  if (season) query = query.eq('season', season)
  if (round) query = query.eq('round', parseInt(round))
  if (roundId) query = query.eq('round_id', roundId)

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

  // Accepts single object or array for bulk insert
  const rows = Array.isArray(body) ? body : [body]

  const inserts = rows.map((r) => ({
    league_id: params.leagueId,
    driver_id: r.driver_id,
    season: r.season,
    round: r.round,
    round_id: r.round_id ?? null,
    track: r.track ?? null,
    qualifying_position: r.qualifying_position ?? null,
    finish_position: r.finish_position ?? null,
    dnf: r.dnf ?? false,
    dnf_reason: r.dnf_reason ?? null,
    fastest_lap: r.fastest_lap ?? false,
    points_earned: r.points_earned ?? 0,
    penalty_points_added: r.penalty_points_added ?? 0,
  }))

  const { data, error } = await supabase
    .schema('pitboss')
    .from('results')
    .insert(inserts)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
