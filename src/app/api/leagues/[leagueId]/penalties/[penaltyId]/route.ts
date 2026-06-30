import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function DELETE(
  req: NextRequest,
  { params }: { params: { leagueId: string; penaltyId: string } }
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

  const { data: issuerDriver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', user.user_metadata?.provider_id ?? user.id)
    .maybeSingle()

  const { data, error } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .update({
      removed_at: new Date().toISOString(),
      removed_by: issuerDriver?.id ?? null,
    })
    .eq('id', params.penaltyId)
    .eq('league_id', params.leagueId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
