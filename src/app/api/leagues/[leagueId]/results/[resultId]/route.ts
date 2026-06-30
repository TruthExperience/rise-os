import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function PUT(
  req: NextRequest,
  { params }: { params: { leagueId: string; resultId: string } }
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
  const allowed = [
    'finish_position', 'qualifying_position', 'dnf', 'dnf_reason',
    'fastest_lap', 'points_earned', 'penalty_points_added', 'track',
  ]
  const update = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  )

  const { data, error } = await supabase
    .schema('pitboss')
    .from('results')
    .update(update)
    .eq('id', params.resultId)
    .eq('league_id', params.leagueId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
