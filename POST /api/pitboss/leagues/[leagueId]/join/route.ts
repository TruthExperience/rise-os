import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(
  req: NextRequest,
  { params }: { params: { leagueId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = (session.user as any).discordId
  if (!discordId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { leagueId } = params

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) return NextResponse.json({ error: driverError.message }, { status: 500 })
  if (!driver) return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  if (['suspended', 'revoked'].includes(driver.super_licence_status)) {
    return NextResponse.json(
      { error: `Cannot join league — super licence is ${driver.super_licence_status}` },
      { status: 403 }
    )
  }

  // Check league exists
  const { data: league } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name')
    .eq('id', leagueId)
    .maybeSingle()

  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 })

  // Check not already a member
  const { data: existing } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('id, certified')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: existing.certified ? 'Already a certified member' : 'Join request already registered' },
      { status: 409 }
    )
  }

  const { error: insertError } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .insert({
      driver_id:  driver.id,
      league_id:  leagueId,
      role:       'driver',
      certified:  false,
    })

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

  return NextResponse.json({ success: true, league_id: leagueId })
}
