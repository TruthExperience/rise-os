// src/app/api/pitboss/leagues/[id]/drivers/route.ts
//
// Returns the selectable driver roster for a league.
//
// Source of truth is pitboss.driver_leagues (every league has these rows),
// joined to pitboss.drivers. pitboss.credential_registry is used only to
// ENRICH rows with team / car number / primary role when a credential exists.
// (Previously the roster was built from credential_registry alone, which only
// has rows for one league, so every other league came back empty.)

import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const requester = await getAuthedDriver()
  if (!requester) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = params.id
  const search = req.nextUrl.searchParams.get('search')?.trim().toLowerCase() ?? ''
  const includeRetired = req.nextUrl.searchParams.get('include_retired') === 'true'

  const supabase = createAdminClient()

  // Only members of the league can see its roster.
  const { data: membership } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('driver_id')
    .eq('driver_id', requester.id)
    .eq('league_id', leagueId)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 })
  }

  // 1. Base roster: league members who are drivers.
  const { data: members, error: memErr } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('driver_id, role, is_driver, driver_number')
    .eq('league_id', leagueId)
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 })

  const driverMembers = (members ?? []).filter((m) => m.is_driver || m.role === 'driver')
  const driverIds = driverMembers.map((m) => m.driver_id)
  if (driverIds.length === 0) return NextResponse.json({ drivers: [] })

  // 2. Driver profiles (chunked to keep the URL small for large leagues).
  const drivers: any[] = []
  for (let i = 0; i < driverIds.length; i += 200) {
    const { data, error } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_id, discord_username, display_name, discord_avatar')
      .in('id', driverIds.slice(i, i + 200))
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    drivers.push(...(data ?? []))
  }

  // 3. Optional enrichment from credential_registry (team, car number, role).
  let credQuery = supabase
    .schema('pitboss')
    .from('credential_registry')
    .select('discord_id, team, car_number, role_primary, is_retired')
    .eq('league_id', leagueId)
    .neq('discord_id', '')
  if (!includeRetired) credQuery = credQuery.eq('is_retired', false)
  const { data: creds } = await credQuery
  const credByDiscordId = new Map<string, any>()
  for (const c of creds ?? []) {
    if (!credByDiscordId.has(c.discord_id)) credByDiscordId.set(c.discord_id, c)
  }

  const memberByDriverId = new Map(driverMembers.map((m) => [m.driver_id, m]))

  const roster = drivers
    .map((d) => {
      const c = credByDiscordId.get(d.discord_id)
      const m = memberByDriverId.get(d.id)
      return {
        id: d.id,
        discord_username: d.discord_username ?? '',
        display_name: d.display_name,
        discord_avatar: d.discord_avatar,
        team: c?.team ?? null,
        car_number: c?.car_number ?? m?.driver_number ?? null,
        role_primary: c?.role_primary ?? m?.role ?? null,
      }
    })
    .sort((a, b) =>
      (a.display_name ?? a.discord_username).localeCompare(b.display_name ?? b.discord_username)
    )

  const filtered = search
    ? roster.filter((r) =>
        (r.display_name ?? r.discord_username).toLowerCase().includes(search) ||
        r.discord_username.toLowerCase().includes(search) ||
        (r.team ?? '').toLowerCase().includes(search)
      )
    : roster

  return NextResponse.json({ drivers: filtered })
}
