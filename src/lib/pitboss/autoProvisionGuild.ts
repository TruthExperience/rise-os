// src/lib/pitboss/autoProvisionGuild.ts
//
// Auto-setup for a Discord server, so admins don't have to run /roles map and
// /roles sync by hand. Called when the bot joins a server (via the guardian's
// GUILD_CREATE hook -> /api/pitboss/guild-joined) and from the "Auto-detect
// from Discord" button on the setup dashboard.
//
// What it does for the league that owns the server:
//   1. Finds the league (by discord_server_id; or, for a server with no link
//      yet, the one unlinked league whose commissioner owns that server).
//   2. Reads roles and maps obvious ones to PitBoss flags (steward, head
//      steward, BSAC chief, team principal, driver, commissioner, co-owner).
//      Additive: roles that already have a mapping are left alone, new roles
//      get picked up on every run.
//   3. Reads channels and fills the ticket category, steward role, incident,
//      transcript and appeals fields -- ONLY the ones that are still empty.
//   4. Runs the full member sync (adds every member, applies mapped flags).
//
// Idempotent. Without `force`, a league that already has mappings and drivers
// is skipped, so gateway reconnects stay cheap.
//
// Server-only.

import { createAdminClient } from '@/lib/supabase/server'
import { syncLeagueRoles } from '@/lib/discord/commands/roles'

const DISCORD_API = 'https://discord.com/api/v10'

export interface GuildSnapshot {
  id: string
  name?: string
  owner_id?: string
  roles?: { id: string; name: string; managed?: boolean }[]
  channels?: { id: string; name: string; type: number; parent_id?: string | null }[]
}

type Flag = 'is_co_owner' | 'is_commissioner' | 'is_head_steward' | 'is_bsac_chief' | 'is_team_principal' | 'is_steward' | 'is_driver'

const ROLE_RULES: { flag: Flag; match: RegExp; exclude?: RegExp }[] = [
  { flag: 'is_co_owner', match: /co[-\s]?owner/i },
  // "Owner" roles map to co-owner (full admin): is_owner itself is never mappable.
  { flag: 'is_co_owner', match: /^\W*(league\s*|server\s*)?(owner|founder)s?\W*$/i },
  { flag: 'is_commissioner', match: /commissioner|league\s*(manager|director)/i, exclude: /co[-\s]?commissioner/i },
  { flag: 'is_head_steward', match: /(head|chief|lead)\s*steward/i },
  { flag: 'is_bsac_chief', match: /bsac.*(chief|justice|head)|chief.*bsac/i },
  { flag: 'is_team_principal', match: /team\s*principal/i },
  { flag: 'is_steward', match: /steward|marshal/i, exclude: /(head|chief|lead)\s*steward|bsac/i },
  { flag: 'is_driver', match: /\b(driver|racer)s?\b/i, exclude: /reserve|trial|applicant|aspiring|prospect/i },
]

export interface ProvisionResult {
  ok: boolean
  skipped?: string
  error?: string
  leagueId?: string
  leagueName?: string
  linked?: boolean
  mappedRoles?: { role: string; flag: string }[]
  channelsSet?: string[]
  members?: { added: number; flagChanges: number } | { error: string }
}

function botHeaders() {
  return { Authorization: `Bot ${process.env.PITBOSS_DISCORD_BOT_TOKEN}` }
}

async function fetchSnapshot(guildId: string): Promise<GuildSnapshot | { error: string }> {
  const [rolesRes, chanRes] = await Promise.all([
    fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers: botHeaders() }),
    fetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: botHeaders() }),
  ])
  if (!rolesRes.ok || !chanRes.ok) {
    return {
      error: `Discord returned HTTP ${!rolesRes.ok ? rolesRes.status : chanRes.status}. Make sure the PitBoss bot is in the server.`,
    }
  }
  return { id: guildId, roles: await rolesRes.json(), channels: await chanRes.json() }
}

export async function autoProvisionGuild(opts: {
  guildId: string
  /** Use this league instead of resolving one from the server. */
  leagueId?: string
  /** Re-run even if the league already looks set up. */
  force?: boolean
  /** Roles/channels already in hand (guardian GUILD_CREATE); fetched via REST if omitted. */
  snapshot?: GuildSnapshot
}): Promise<ProvisionResult> {
  const { guildId, force = false } = opts
  const root = createAdminClient() as any
  const rise = () => root.schema('rise_os')
  const pb = () => root.schema('pitboss')

  // ── 1. Resolve the league ────────────────────────────────────────────
  let league: any = null
  let linked = false

  if (opts.leagueId) {
    const { data } = await rise().from('leagues').select('*').eq('id', opts.leagueId).maybeSingle()
    league = data
  } else {
    const { data } = await rise().from('leagues').select('*').eq('discord_server_id', guildId).maybeSingle()
    league = data
  }

  if (!league && opts.snapshot?.owner_id) {
    const { data: owner } = await root
      .from('users')
      .select('id')
      .eq('discord_id', opts.snapshot.owner_id)
      .maybeSingle()
    if (owner) {
      const { data: candidates } = await rise()
        .from('leagues')
        .select('*')
        .eq('commissioner_id', owner.id)
        .is('discord_server_id', null)
      if (candidates?.length === 1) league = candidates[0]
    }
  }

  if (!league) return { ok: true, skipped: 'no league is linked to this server yet' }

  if (!league.discord_server_id) {
    const { error } = await rise()
      .from('leagues')
      .update({ discord_server_id: guildId, updated_at: new Date().toISOString() })
      .eq('id', league.id)
    if (error) return { ok: false, error: error.message, leagueId: league.id }
    league.discord_server_id = guildId
    linked = true
  } else if (league.discord_server_id !== guildId) {
    return { ok: false, error: 'League is linked to a different Discord server', leagueId: league.id }
  }

  // ── cheap skip for reconnect storms ──────────────────────────────────
  const { count: mapCount } = await pb()
    .from('league_role_map')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', league.id)
  if (!force && !linked && (mapCount ?? 0) > 0) {
    const { count: driverCount } = await pb()
      .from('driver_leagues')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', league.id)
      .eq('is_driver', true)
    if ((driverCount ?? 0) > 0) {
      return { ok: true, skipped: 'already provisioned', leagueId: league.id, leagueName: league.name }
    }
  }

  // ── 2. Read the server ───────────────────────────────────────────────
  let snap: GuildSnapshot
  if (opts.snapshot?.roles && opts.snapshot?.channels) {
    snap = opts.snapshot
  } else {
    const fetched = await fetchSnapshot(guildId)
    if ('error' in fetched) return { ok: false, error: fetched.error, leagueId: league.id, linked }
    snap = fetched
  }
  const roles = (snap.roles ?? []).filter((r) => r.id !== guildId && !r.managed)
  const channels = snap.channels ?? []

  // ── 3. Map roles (only if nothing is mapped yet) ─────────────────────
  const mappedRoles: { role: string; flag: string }[] = []
  {
    const { data: existing } = await pb().from('league_role_map').select('discord_role_id').eq('league_id', league.id)
    const already = new Set(((existing ?? []) as { discord_role_id: string }[]).map((r) => r.discord_role_id))
    const rows: { league_id: string; discord_role_id: string; flag: Flag }[] = []
    for (const role of roles) {
      if (already.has(role.id)) continue
      const rule = ROLE_RULES.find((r) => r.match.test(role.name) && !(r.exclude && r.exclude.test(role.name)))
      if (rule) {
        rows.push({ league_id: league.id, discord_role_id: role.id, flag: rule.flag })
        mappedRoles.push({ role: role.name, flag: rule.flag })
      }
    }
    if (rows.length > 0) {
      const { error } = await pb()
        .from('league_role_map')
        .upsert(rows, { onConflict: 'league_id,discord_role_id,flag', ignoreDuplicates: true })
      if (error) {
        console.error('[autoProvision] role map failed:', error)
        mappedRoles.length = 0
      }
    }
  }

  // ── 4. Fill empty channel / role settings ────────────────────────────
  const text = channels.filter((c) => c.type === 0)
  const pick = (list: typeof channels, re: RegExp) => list.find((c) => re.test(c.name))?.id ?? null
  const stewardRole =
    roles.find((r) => /steward/i.test(r.name) && !/(head|chief|lead)\s*steward/i.test(r.name)) ??
    roles.find((r) => /steward/i.test(r.name))

  const detected: Record<string, string | null> = {
    discord_ticket_category_id: pick(channels.filter((c) => c.type === 4), /ticket|support|steward|incident/i),
    discord_steward_role_id: stewardRole?.id ?? null,
    discord_incident_channel_id: pick(text, /incident|report/i),
    discord_transcript_channel_id: pick(text, /transcript/i),
    discord_appeals_channel_id: pick(text, /appeal/i),
  }
  const patch: Record<string, string> = {}
  for (const [field, value] of Object.entries(detected)) {
    if (value && !league[field]) patch[field] = value
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await rise()
      .from('leagues')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', league.id)
    if (error) {
      console.error('[autoProvision] channel update failed:', error)
      Object.keys(patch).forEach((k) => delete patch[k])
    }
  }

  // ── 5. Member sync ───────────────────────────────────────────────────
  let members: ProvisionResult['members']
  try {
    const sync = await syncLeagueRoles(league.id, guildId, true)
    members = sync.ok
      ? { added: sync.additions.length, flagChanges: sync.changes.length }
      : { error: sync.error }
  } catch (e: any) {
    members = { error: e?.message ?? 'Member sync failed' }
  }

  return {
    ok: true,
    leagueId: league.id,
    leagueName: league.name,
    linked,
    mappedRoles,
    channelsSet: Object.keys(patch),
    members,
  }
}
