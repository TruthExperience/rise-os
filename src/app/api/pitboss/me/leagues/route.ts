import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

function getPitboss() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

function getRiseOs() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'rise_os' } }
  )
}

function getPublic() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated', debug: { hadSession: !!session, sessionUser: session?.user ?? null } }, { status: 401 })
  }

  const pitboss = getPitboss()
  const riseOs = getRiseOs()
  const publicClient = getPublic()

  const { data: userRecord, error: userErr } = await publicClient
    .from('users')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  const membershipMap: Record<string, { role: string; certified: boolean }> = {}

  const { data: driver, error: driverErr } = await pitboss
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  let driverLeagues: any = null
  let dlErr: any = null
  if (driver) {
    const res = await pitboss
      .from('driver_leagues')
      .select('league_id, role, certified')
      .eq('driver_id', driver.id)
    driverLeagues = res.data
    dlErr = res.error

    for (const dl of driverLeagues ?? []) {
      membershipMap[dl.league_id] = { role: dl.role, certified: Boolean(dl.certified) }
    }
  }

  let leagueAdmins: any = null
  let laErr: any = null
  if (userRecord) {
    const res = await riseOs
      .from('league_admins')
      .select('league_id, role')
      .eq('user_id', userRecord.id)
    leagueAdmins = res.data
    laErr = res.error

    for (const la of leagueAdmins ?? []) {
      membershipMap[la.league_id] = { role: la.role, certified: true }
    }
  }

  const debug = {
    discordId: session.user.discordId,
    userRecord, userErr,
    driver, driverErr,
    driverLeagues, dlErr,
    leagueAdmins, laErr,
    membershipMap,
  }

  const leagueIds = Object.keys(membershipMap)
  if (leagueIds.length === 0) {
    return NextResponse.json({ result: [], debug })
  }

  const { data: leagues, error } = await riseOs
    .from('leagues')
    .select('id, name, sport, logo_url')
    .in('id', leagueIds)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message, debug }, { status: 500 })

  const result = (leagues ?? []).map((l) => ({
    id: l.id,
    league_id: l.id,
    role: membershipMap[l.id].role,
    certified: membershipMap[l.id].certified,
    league: { name: l.name, sport: l.sport, logo_url: l.logo_url },
  }))

  return NextResponse.json({ result, debug })
}
