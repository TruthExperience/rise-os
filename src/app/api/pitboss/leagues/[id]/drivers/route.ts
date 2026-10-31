// src/app/api/pitboss/leagues/[id]/drivers/route.ts
//
// Returns the selectable driver roster for a league.
//
// Source of truth is pitboss.driver_leagues (every league has these rows),
// joined to pitboss.drivers. Team is resolved per driver, first hit wins:
//   1. pitboss.franchise_rosters (active, latest season) -> rise_os.franchises.name
//   2. pitboss.team_rosters (latest season)              -> pitboss.car_class_teams.team_name
//   3. Discord team role in driver_leagues.discord_roles  -> pitboss.league_team_roles -> car_class_teams
//   4. pitboss.credential_registry.team
// credential_registry also enriches car number / primary role when present.
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
    .select('driver_id, role, is_driver, driver_number, discord_roles')
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

  // 4a. Team via franchise_rosters (latest season, not released).
  const teamByDriverId = new Map<string, string>()
  const { data: frRows } = await supabase
    .schema('pitboss')
    .from('franchise_rosters')
    .select('driver_id, franchise_id, season, released_at')
    .eq('league_id', leagueId)
    .is('released_at', null)
    .order('season', { ascending: false })
  const frLatest = new Map<string, string>() // driver_id -> franchise_id
  for (const r of frRows ?? []) if (!frLatest.has(r.driver_id)) frLatest.set(r.driver_id, r.franchise_id)
  const franchiseIds = [...new Set(frLatest.values())]
  if (franchiseIds.length > 0) {
    const { data: fr } = await supabase
      .schema('rise_os')
      .from('franchises')
      .select('id, name')
      .in('id', franchiseIds)
    const nameById = new Map((fr ?? []).map((f: any) => [f.id, f.name]))
    for (const [driverId, fid] of frLatest) {
      const n = nameById.get(fid)
      if (n) teamByDriverId.set(driverId, n)
    }
  }

  // 4b. Team via team_rosters -> car_class_teams, plus Discord role map.
  const { data: trRows } = await supabase
    .schema('pitboss')
    .from('team_rosters')
    .select('driver_id, car_class_team_id, season')
    .eq('league_id', leagueId)
    .order('season', { ascending: false })
  const { data: roleRows } = await supabase
    .schema('pitboss')
    .from('league_team_roles')
    .select('car_class_team_id, discord_role_id')
    .eq('league_id', leagueId)

  const cctIds = [
    ...new Set([
      ...(trRows ?? []).map((r) => r.car_class_team_id),
      ...(roleRows ?? []).map((r) => r.car_class_team_id),
    ].filter(Boolean)),
  ]
  const cctName = new Map<string, string>()
  if (cctIds.length > 0) {
    const { data: cct } = await supabase
      .schema('pitboss')
      .from('car_class_teams')
      .select('id, team_name')
      .in('id', cctIds)
    for (const t of cct ?? []) cctName.set(t.id, t.team_name)
  }
  for (const r of trRows ?? []) {
    if (teamByDriverId.has(r.driver_id)) continue
    const n = cctName.get(r.car_class_team_id)
    if (n) teamByDriverId.set(r.driver_id, n)
  }
  const teamByRoleId = new Map(
    (roleRows ?? []).map((r) => [String(r.discord_role_id), cctName.get(r.car_class_team_id)])
  )
  for (const m of driverMembers) {
    if (teamByDriverId.has(m.driver_id)) continue
    const roles: any[] = Array.isArray(m.discord_roles) ? m.discord_roles : []
    for (const role of roles) {
      const n = teamByRoleId.get(String(role?.id ?? role))
      if (n) { teamByDriverId.set(m.driver_id, n); break }
    }
  }

  const roster = drivers
    .map((d) => {
      const c = credByDiscordId.get(d.discord_id)
      const m = memberByDriverId.get(d.id)
      return {
        id: d.id,
        discord_username: d.discord_username ?? '',
        display_name: d.display_name,
        discord_avatar: d.discord_avatar,
        team: teamByDriverId.get(d.id) ?? c?.team ?? null,
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
