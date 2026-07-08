// src/app/api/pitboss/leagues/[id]/drivers/route.ts
//
// Returns the selectable driver roster for a league, sourced from
// pitboss.credential_registry (the AWC driver list of record) joined to
// pitboss.drivers by discord_id. Used for steward-facing pickers — e.g.
// "accused driver" / "reported by" when opening an incident ticket — and
// by the driver-facing incident report form.
//
// Entries with a blank discord_id (unassigned credential slots — "TBD",
// placeholder cards) are excluded since they have no linked driver record
// and can't be attributed as a party to an incident.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = params.id
  const search = req.nextUrl.searchParams.get('search')?.trim().toLowerCase() ?? ''
  const includeRetired = req.nextUrl.searchParams.get('include_retired') === 'true'

  const supabase = createAdminClient()

  let query = supabase
    .schema('pitboss')
    .from('credential_registry')
    .select('discord_id, username, team, car_number, role_primary, is_retired, card_status')
    .eq('league_id', leagueId)
    .neq('discord_id', '')
    .order('username', { ascending: true })

  if (!includeRetired) query = query.eq('is_retired', false)

  const { data: credentials, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const discordIds = [...new Set((credentials ?? []).map((c) => c.discord_id))]

  let drivers: any[] = []
  if (discordIds.length > 0) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_id, discord_username, display_name, discord_avatar')
      .in('discord_id', discordIds)
    drivers = data ?? []
  }

  const driverByDiscordId = Object.fromEntries(drivers.map((d) => [d.discord_id, d]))

  // Dedupe credential rows by discord_id (a driver can hold multiple
  // credential entries, e.g. dual-tier) and attach the resolved driver id.
  const seen = new Set<string>()
  const roster = []
  for (const c of credentials ?? []) {
    const driver = driverByDiscordId[c.discord_id]
    if (!driver || seen.has(c.discord_id)) continue
    seen.add(c.discord_id)
    roster.push({
      id: driver.id,
      discord_username: driver.discord_username,
      display_name: driver.display_name,
      discord_avatar: driver.discord_avatar,
      team: c.team,
      car_number: c.car_number,
      role_primary: c.role_primary,
    })
  }

  const filtered = search
    ? roster.filter((r) =>
        (r.display_name ?? r.discord_username).toLowerCase().includes(search) ||
        r.discord_username.toLowerCase().includes(search) ||
        (r.team ?? '').toLowerCase().includes(search)
      )
    : roster

  return NextResponse.json({ drivers: filtered })
}
