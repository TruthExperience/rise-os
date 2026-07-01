import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getRiseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'rise_os' } }
  )
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const publicClient = getPublicClient()
  const riseClient = getRiseClient()
  const userId = params.id

  const { data: user, error: userErr } = await publicClient
    .from('users')
    .select('id, username, discord_id, avatar, created_at')
    .eq('id', userId)
    .single()

  if (userErr || !user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { data: franchises } = await riseClient
    .from('franchises')
    .select('id, league_id, name, abbreviation, logo_url, primary_color, secondary_color, wins, losses, championships, created_at')
    .eq('gm_id', userId)
    .order('created_at', { ascending: true })

  const leagueIds = [...new Set((franchises ?? []).map((f: any) => f.league_id))]
  let leagueMap: Record<string, any> = {}
  if (leagueIds.length > 0) {
    const { data: leagues } = await riseClient
      .from('leagues')
      .select('id, name, slug')
      .in('id', leagueIds)
    leagueMap = Object.fromEntries((leagues ?? []).map((l: any) => [l.id, l]))
  }

  const franchisesEnriched = await Promise.all(
    (franchises ?? []).map(async (f: any) => {
      const { data: roster } = await riseClient
        .from('players')
        .select('id, name, position, ovr, dev_trait, class_year, status')
        .eq('franchise_id', f.id)
        .eq('status', 'active')
        .order('ovr', { ascending: false })
        .limit(8)

      const totalGames = (f.wins ?? 0) + (f.losses ?? 0)
      const winPct = totalGames > 0 ? ((f.wins / totalGames) * 100).toFixed(1) : null

      return {
        ...f,
        league: leagueMap[f.league_id] ?? null,
        roster: roster ?? [],
        total_games: totalGames,
        win_pct: winPct,
      }
    })
  )

  const { data: adminRoles } = await riseClient
    .from('league_admins')
    .select('league_id, role')
    .eq('user_id', userId)

  const adminRolesEnriched = (adminRoles ?? []).map((a: any) => ({
    ...a,
    league: leagueMap[a.league_id] ?? null,
  }))

  const totalWins = franchisesEnriched.reduce((s, f) => s + (f.wins ?? 0), 0)
  const totalLosses = franchisesEnriched.reduce((s, f) => s + (f.losses ?? 0), 0)
  const totalChampionships = franchisesEnriched.reduce((s, f) => s + (f.championships ?? 0), 0)

  return NextResponse.json({
    user,
    franchises: franchisesEnriched,
    adminRoles: adminRolesEnriched,
    stats: { totalWins, totalLosses, totalChampionships },
  })
}
