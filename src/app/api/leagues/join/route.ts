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
// does.
//
// This route lives at src/app/api/leagues/join/route.ts -- a flat path,
// no [leagueId] dynamic segment -- so the league ID is NOT available via
// params. It must be read from the JSON request body instead. (A separate,
// now-abandoned [leagueId]/join route existed alongside this one; this is
// the one the "Join a League" UI actually calls.)
export async function POST(req: NextRequest) {
  const userId = await getSupabaseUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let leagueId: string | undefined
  try {
    const body = await req.json()
    leagueId = body?.leagueId
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!leagueId) {
    return NextResponse.json({ error: 'leagueId is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .schema('rise_os')
    .rpc('join_league', { p_user_id: userId, p_league_id: leagueId })

  if (error) {
    const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 500
    return NextResponse.json({ error: error.message }, { status })
  }

  return NextResponse.json({ success: true, league_id: leagueId, membership: data })
}
