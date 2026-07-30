import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// This route used to duplicate the join logic directly (driver lookup,
// licence check, insert into pitboss.driver_leagues) with no awareness of
// rise_os.league_members. That duplication drifted from the actual
// "Join a League" UI, which calls rise_os.join_league() -- the licence
// check that used to live only here has since been moved into that RPC.
// Kept as a thin wrapper rather than deleted outright, in case anything
// else still points at this URL shape.
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

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (userError) return NextResponse.json({ error: userError.message }, { status: 500 })
  if (!userRow) return NextResponse.json({ error: 'User profile not found' }, { status: 404 })

  const { data, error } = await supabase
    .schema('rise_os')
    .rpc('join_league', { p_user_id: userRow.id, p_league_id: params.leagueId })

  if (error) {
    const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 500
    return NextResponse.json({ error: error.message }, { status })
  }

  return NextResponse.json({ success: true, league_id: params.leagueId, membership: data })
}
