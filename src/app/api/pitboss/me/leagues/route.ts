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

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const pitboss = getPitboss()
  const riseOs = getRiseOs()

  // Pull sim racing roles where available (pitboss schema)
  let roleMap: Record<string, string> = {}
  const { data: driver } = await pitboss
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  if (driver) {
    const { data: driverLeagues } = await pitboss
      .from('driver_leagues')
      .select('league_id, role')
      .eq('driver_id', driver.id)

    for (const dl of driverLeagues ?? []) {
      roleMap[dl.league_id] = dl.role
    }
  }

  // Fetch all leagues with display info
  const { data: leagues, error } = await riseOs
    .from('leagues')
    .select('id, name, sport, logo_url, is_public, commissioner_id')
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const result = (leagues ?? []).map((l) => ({
    league_id: l.id,
    name: l.name,
    sport: l.sport,
    logo_url: l.logo_url,
    role: roleMap[l.id] ?? (l.commissioner_id ? 'commissioner' : 'member'),
  }))

  return NextResponse.json({ leagues: result })
}
