import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseUserId } from '@/lib/getSupabaseUserId'

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
//
// 2026-08-13: switched from getServerSession(authOptions) (dead NextAuth
// path, no active sessions post Supabase Auth migration) to
// getSupabaseUserId(), which uses getClaims() the same way middleware.ts
// does. Also fixed the dynamic segment name -- this route lives at
// [leagueId], not [id], so params.id was always undefined.
export async function POST(
  req: NextRequest,
  { params }: { params: { leagueId: string } }
) {
  const userId = await getSupabaseUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .schema('rise_os')
    .rpc('join_league', { p_user_id: userId, p_league_id: params.leagueId })

  if (error) {
    const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 500
    return NextResponse.json({ error: error.message }, { status })
  }

  return NextResponse.json({ success: true, league_id: params.leagueId, membership: data })
}
