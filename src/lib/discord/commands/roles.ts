import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Discord role -> PitBoss permission flag mapping.
//
//   /roles map   role:@X flag:...   link a Discord role to a flag
//   /roles unmap role:@X [flag]     remove a link (all flags for the role if omitted)
//   /roles list                     show the current mapping
//   /roles sync  [apply]            mirror the Discord server onto pitboss.driver_leagues
//
// Dispatch keys: roles_map / roles_unmap / roles_list / roles_sync.
//
// Automatic syncing (no command needed):
//  1. syncMemberRoles() — called from the command router on every slash
//     command in a guild, BEFORE the permission check. It reads the roles
//     Discord already put on the interaction and fixes that one member's
//     flags, so a new or removed role takes effect the next time they use
//     the bot. (Flags only; the role snapshot refreshes on the bulk sync.)
//  2. syncLeagueRoles() — called by /api/cron/roles-sync on a schedule to
//     mirror every member, so people who haven't used the bot (and the web
//     app) stay correct too.
//
// Bulk sync rules (syncLeagueRoles):
//  - EVERY Discord role a member holds is snapshotted into
//    pitboss.driver_leagues.discord_roles as [{id, name}] (@everyone
//    excluded). Informational only; permissions come from the is_* flags.
//  - Every non-bot server member who isn't in the league yet is added (a
//    pitboss.drivers row is created if they have none).
//  - Only flags that have at least one mapping are managed. Flags with no
//    mapping are never touched.
//  - For a managed flag, a member gets it if they hold ANY role mapped to it,
//    and loses it if they hold none (so removing a role removes the flag).
//  - is_owner is never mappable and never changed by a sync.
//  - Members who are in PitBoss but no longer in the server (left OR banned)
//    are only DELETED when the caller passes { removeLeavers: true } (the
//    /roles sync apply:true path). The scheduled sync never deletes; it just
//    reports them. Deleting removes the driver_leagues row (flags + role
//    snapshot). The pitboss.drivers row and all history are kept. Owners,
//    co-owners and commissioners are never deleted, only reported.
//  - /roles sync defaults to a preview; pass apply:true to write changes.
//    The scheduled and per-command syncs always apply (without deleting).
//
// Tables: pitboss.league_role_map (league_id, discord_role_id, flag),
//         pitboss.driver_leagues (flags + discord_roles),
//         pitboss.drivers (created for members PitBoss has never seen).
//
// Who can run /roles: owner / co-owner / commissioner, or a Discord
// Administrator (so a brand-new league's owner can bootstrap it).

const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR = BigInt(1) << BigInt(3);
const DISCORD_MAX = 2000;

const MANAGER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;

// TEMPORARY: flags the role sync must leave alone for specific people while
// they help set up a league. Keyed "<leagueId>:<discordId>". DELETE this block
// (and the two isPinned() checks below) once setup is finished.
const TEMP_PINNED_FLAGS: Record<string, string[]> = {
  "992e968c-c0e5-4aea-9fb2-bc19c3468fc6:1047084061027471480": ["is_commissioner"], // EFRL
};
function isPinned(leagueId: string, discordId: string, flag: string): boolean {
  return TEMP_PINNED_FLAGS[`${leagueId}:${discordId}`]?.includes(flag) ?? false;
}

const MAPPABLE_FLAGS = [
  "is_co_owner",
  "is_commissioner",
  "is_head_steward",
  "is_steward",
  "is_bsac_chief",
  "is_team_principal",
  "is_driver",
] as const;
type MappableFlag = (typeof MAPPABLE_FLAGS)[number];

const FLAG_LABEL: Record<MappableFlag, string> = {
  is_co_owner: "Co-owner",
  is_commissioner: "Commissioner",
  is_head_steward: "Head steward",
  is_steward: "Steward",
  is_bsac_chief: "BSAC chief",
  is_team_principal: "Team principal",
  is_driver: "Driver",
};

interface StoredRole {
  id: string;
  name: string;
}

function db() {
  // Untyped on purpose: flag columns are written by computed key.
  return (createAdminClient() as any).schema("pitboss");
}

function isMappableFlag(value: unknown): value is MappableFlag {
  return typeof value === "string" && (MAPPABLE_FLAGS as readonly string[]).includes(value);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function requireManager(ctx: {
  leagueId: string | undefined;
  discordUserId: string;
  memberPermissions: string;
}): Promise<string | null> {
  if (!ctx.leagueId) return "This command must be used in a league channel.";

  const isAdmin = (BigInt(ctx.memberPermissions || "0") & ADMINISTRATOR) !== BigInt(0);
  if (isAdmin) return null;

  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...MANAGER_FLAGS])) {
    return "Only league owners, co-owners, commissioners or server admins can manage role mappings.";
  }
  return null;
}

interface MapRow {
  discord_role_id: string;
  flag: MappableFlag;
}

async function loadMappings(leagueId: string): Promise<MapRow[]> {
  const { data } = await db()
    .from("league_role_map")
    .select("discord_role_id, flag")
    .eq("league_id", leagueId);
  return (data ?? []) as MapRow[];
}

// ─── /roles map ─────────────────────────────────────────────────────────

registerCommand("roles_map", async (ctx) => {
  const denied = await requireManager(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const roleId = ctx.options.role as string | undefined;
  const flag = ctx.options.flag;
  if (!roleId) return { content: "Pick a role.", ephemeral: true };
  if (!isMappableFlag(flag)) return { content: "Pick a valid permission.", ephemeral: true };

  const { error } = await db()
    .from("league_role_map")
    .upsert(
      { league_id: ctx.leagueId, discord_role_id: roleId, flag },
      { onConflict: "league_id,discord_role_id,flag", ignoreDuplicates: true }
    );
  if (error) {
    console.error("[roles_map] failed:", error);
    return { content: `Couldn't save that mapping: ${error.message}`, ephemeral: true };
  }

  return {
    content:
      `Mapped <@&${roleId}> → **${FLAG_LABEL[flag]}**. ` +
      `From now on **${FLAG_LABEL[flag]}** follows that role automatically. ` +
      `Run \`/roles sync\` to preview what it changes right now.`,
    ephemeral: true,
  };
});

// ─── /roles unmap ───────────────────────────────────────────────────────

registerCommand("roles_unmap", async (ctx) => {
  const denied = await requireManager(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const roleId = ctx.options.role as string | undefined;
  const flag = ctx.options.flag;
  if (!roleId) return { content: "Pick a role.", ephemeral: true };

  let query = db()
    .from("league_role_map")
    .delete()
    .eq("league_id", ctx.leagueId)
    .eq("discord_role_id", roleId);
  if (flag !== undefined && flag !== null && flag !== "") {
    if (!isMappableFlag(flag)) return { content: "Pick a valid permission.", ephemeral: true };
    query = query.eq("flag", flag);
  }

  const { data, error } = await query.select("id");
  if (error) {
    console.error("[roles_unmap] failed:", error);
    return { content: `Couldn't remove that mapping: ${error.message}`, ephemeral: true };
  }

  const removed = (data ?? []).length;
  if (removed === 0) return { content: "That role wasn't mapped.", ephemeral: true };

  return {
    content:
      `Removed ${removed} mapping${removed === 1 ? "" : "s"} for <@&${roleId}>. ` +
      `Flags already granted stay until you map the flag again or change them by hand — ` +
      `an unmapped flag is no longer managed automatically.`,
    ephemeral: true,
  };
});

// ─── /roles list ────────────────────────────────────────────────────────

registerCommand("roles_list", async (ctx) => {
  const denied = await requireManager(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const rows = await loadMappings(ctx.leagueId as string);
  if (rows.length === 0) {
    return {
      content: "No roles are mapped yet. Use `/roles map` to link a Discord role to a permission.",
      ephemeral: true,
    };
  }

  const lines = ["**Role mappings**"];
  for (const flag of MAPPABLE_FLAGS) {
    const roles = rows.filter((r) => r.flag === flag).map((r) => `<@&${r.discord_role_id}>`);
    if (roles.length > 0) lines.push(`${FLAG_LABEL[flag]}: ${roles.join(", ")}`);
  }
  lines.push("", "Mapped flags follow Discord roles automatically. Unmapped flags are never changed.");
  return { content: lines.join("\n"), ephemeral: true };
});

// ─── Automatic sync: one member, from the interaction payload ────────────

/**
 * Fixes one member's mapped flags from the roles Discord attached to their
 * interaction. Cheap (no Discord API call) and never throws — a failure here
 * must not block the command the member is actually running.
 */
export async function syncMemberRoles(
  leagueId: string,
  discordUserId: string,
  memberRoles: string[]
): Promise<void> {
  try {
    const mappings = await loadMappings(leagueId);
    if (mappings.length === 0) return;

    const { data: driver } = await db()
      .from("drivers")
      .select("id")
      .eq("discord_id", discordUserId)
      .maybeSingle();
    if (!driver) return;

    const { data: row } = await db()
      .from("driver_leagues")
      .select(`id, ${MAPPABLE_FLAGS.join(", ")}`)
      .eq("league_id", leagueId)
      .eq("driver_id", driver.id)
      .maybeSingle();
    if (!row) return;

    const managed = MAPPABLE_FLAGS.filter((f) => mappings.some((m) => m.flag === f));
    const patch: Record<string, boolean> = {};
    for (const flag of managed) {
      if (isPinned(leagueId, discordUserId, flag)) continue;
      const want = mappings
        .filter((m) => m.flag === flag)
        .some((m) => memberRoles.includes(m.discord_role_id));
      if (want !== (row[flag] === true)) patch[flag] = want;
    }

    if (Object.keys(patch).length === 0) return;

    const { error } = await db().from("driver_leagues").update(patch).eq("id", row.id);
    if (error) console.error("[roles] per-member sync update failed:", error);
  } catch (err) {
    console.error("[roles] per-member sync failed:", err);
  }
}

// ─── Bulk sync: whole league ────────────────────────────────────────────

function botHeaders() {
  return { Authorization: `Bot ${process.env.PITBOSS_DISCORD_BOT_TOKEN}` };
}

interface GuildMember {
  roles: string[];
  username: string;
  displayName: string;
}

async function fetchGuildMembers(
  guildId: string
): Promise<{ ok: true; members: Map<string, GuildMember> } | { ok: false; error: string }> {
  const members = new Map<string, GuildMember>();
  let after = "0";

  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
      headers: botHeaders(),
    });
    if (!res.ok) {
      return {
        ok: false,
        error:
          res.status === 403
            ? "Discord wouldn't let the bot read the member list. Check that the Server Members Intent is enabled for the bot."
            : `Discord returned HTTP ${res.status} when reading the member list.`,
      };
    }

    const batch = (await res.json()) as {
      user?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
      nick?: string | null;
      roles?: string[];
    }[];

    for (const m of batch) {
      if (!m.user || m.user.bot) continue;
      const username = m.user.username ?? m.user.id;
      members.set(m.user.id, {
        roles: m.roles ?? [],
        username,
        displayName: m.nick || m.user.global_name || username,
      });
    }

    if (batch.length < 1000) return { ok: true, members };
    after = batch[batch.length - 1].user?.id ?? after;
  }

  return { ok: false, error: "The server has too many members to sync in one pass." };
}

// id -> name for every role in the server (@everyone shares the guild id).
async function fetchRoleNames(
  guildId: string
): Promise<{ ok: true; names: Map<string, string> } | { ok: false; error: string }> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers: botHeaders() });
  if (!res.ok) {
    return { ok: false, error: `Discord returned HTTP ${res.status} when reading the server's roles.` };
  }
  const roles = (await res.json()) as { id: string; name: string }[];
  const names = new Map<string, string>();
  for (const r of roles) names.set(r.id, r.name);
  return { ok: true, names };
}

function normaliseStored(value: unknown): StoredRole[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((r): r is StoredRole => !!r && typeof (r as StoredRole).id === "string")
    .map((r) => ({ id: r.id, name: typeof r.name === "string" ? r.name : "" }));
}

function sameRoles(a: StoredRole[], b: StoredRole[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: StoredRole) => `${r.id}:${r.name}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

interface MemberRow {
  id: string;
  driver_id: string;
  discord_roles: unknown;
  drivers:
    | { discord_id: string | null; display_name: string | null; discord_username: string | null }
    | { discord_id: string | null; display_name: string | null; discord_username: string | null }[]
    | null;
  [flag: string]: unknown;
}

export interface LeagueSyncChange {
  id: string;
  name: string;
  patch: Record<string, unknown>;
  notes: string[];
}

export interface LeagueSyncOptions {
  /** Delete the league membership of people who left or were banned. Default false. */
  removeLeavers?: boolean;
}

export type LeagueSyncResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Existing members whose flags and/or role snapshot changed. */
      changes: LeagueSyncChange[];
      /** Display names of server members not yet in the league (added when apply). */
      additions: string[];
      /** Display names of members who left or were banned (deleted only with removeLeavers + apply). */
      removals: string[];
      /** Owners/co-owners/commissioners who are out of the server; never deleted. */
      keptStaff: string[];
      summary: string[];
      footer: string[];
      /** Existing members successfully updated. */
      applied: number;
      /** Members added to the league. */
      added: number;
      /** Memberships deleted. */
      removed: number;
      failed: number;
    };

// ─── Team roles -> rosters ──────────────────────────────────────────────
//
// A Discord role whose name matches a team in the league's car class
// (e.g. "Ferrari", "Red Bull Racing") puts that member on the team:
//  - pitboss.team_rosters      (car_class_teams reference; TP flag copied
//                               from driver_leagues.is_team_principal)
//  - pitboss.franchise_rosters (what check-in, cap and grid read)
// Rules: exactly one team role -> assign or move. No team role -> left
// alone (never released automatically). Two or more -> skipped and reported.
// The season is the latest one already in team_rosters for the league; a
// league with no team_rosters rows yet is skipped.
// Same constant as roster.ts — keep the two in step.
const TEAM_ROLE_CAR_CLASS_ID = "3cbbd45c-7a2e-4501-8f51-a6b5f6b33326";

const normTeam = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface TeamSyncRow {
  driverId: string;
  name: string;
  roleIds: string[];
  isTeamPrincipal: boolean;
}

async function syncTeamRoles(
  leagueId: string,
  roleNames: Map<string, string>,
  members: TeamSyncRow[],
  apply: boolean
): Promise<{ lines: string[]; failed: number }> {
  const lines: string[] = [];
  let failed = 0;

  const { data: seasonRow } = await db()
    .from("team_rosters")
    .select("season, tier")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!seasonRow?.season) return { lines, failed };
  const season = String(seasonRow.season);
  const tier = (seasonRow.tier as string | null) ?? null;

  const { data: teams } = await db()
    .from("car_class_teams")
    .select("id, team_name")
    .eq("car_class_id", TEAM_ROLE_CAR_CLASS_ID);
  const teamByName = new Map<string, { id: string; team_name: string }>();
  for (const t of (teams ?? []) as { id: string; team_name: string }[]) {
    teamByName.set(normTeam(t.team_name), t);
  }
  if (teamByName.size === 0) return { lines, failed };

  const { data: franchises } = await (createAdminClient() as any)
    .schema("rise_os")
    .from("franchises")
    .select("id, name, division")
    .eq("league_id", leagueId);
  const franchiseFor = (teamName: string) => {
    const target = normTeam(teamName);
    const hits = ((franchises ?? []) as { id: string; name: string; division: string | null }[]).filter(
      (f) => normTeam(f.name).includes(target)
    );
    return hits.length === 1 ? hits[0] : null;
  };

  const [{ data: trRows }, { data: frRows }] = await Promise.all([
    db().from("team_rosters").select("id, driver_id, car_class_team_id, is_team_principal").eq("league_id", leagueId).eq("season", season),
    db().from("franchise_rosters").select("id, driver_id, franchise_id").eq("league_id", leagueId).is("released_at", null),
  ]);
  const trByDriver = new Map<string, any>(((trRows ?? []) as any[]).map((r) => [r.driver_id, r]));
  const frByDriver = new Map<string, any>(((frRows ?? []) as any[]).map((r) => [r.driver_id, r]));

  let created = 0;
  let moved = 0;
  const conflicts: string[] = [];
  const noFranchise = new Set<string>();

  for (const m of members) {
    const held = m.roleIds
      .map((id) => teamByName.get(normTeam(roleNames.get(id) ?? "")))
      .filter((t): t is { id: string; team_name: string } => !!t);
    if (held.length === 0) continue;
    if (held.length > 1) {
      conflicts.push(`${m.name} (${held.map((h) => h.team_name).join(" + ")})`);
      continue;
    }
    const team = held[0];

    const tr = trByDriver.get(m.driverId);
    const trChanged = !tr || tr.car_class_team_id !== team.id || (tr.is_team_principal === true) !== m.isTeamPrincipal;
    const fr = frByDriver.get(m.driverId);
    const franchise = franchiseFor(team.team_name);
    if (!franchise) noFranchise.add(team.team_name);
    const frChanged = !!franchise && (!fr || fr.franchise_id !== franchise.id);

    if (!trChanged && !frChanged) continue;
    if (!tr) created++;
    else if (tr.car_class_team_id !== team.id) moved++;
    if (!apply) continue;

    if (trChanged) {
      const res = tr
        ? await db().from("team_rosters").update({ car_class_team_id: team.id, is_team_principal: m.isTeamPrincipal, updated_at: new Date().toISOString() }).eq("id", tr.id)
        : await db().from("team_rosters").insert({ driver_id: m.driverId, league_id: leagueId, car_class_team_id: team.id, tier, season, is_team_principal: m.isTeamPrincipal });
      if (res.error) { failed++; console.error("[roles] team_rosters sync failed:", res.error); }
    }
    if (frChanged && franchise) {
      const res = fr
        ? await db().from("franchise_rosters").update({ franchise_id: franchise.id, division: franchise.division }).eq("id", fr.id)
        : await db().from("franchise_rosters").insert({ driver_id: m.driverId, franchise_id: franchise.id, league_id: leagueId, division: franchise.division, season, tier, source: "discord:roles-sync", created_by: "roles-sync" });
      if (res.error) { failed++; console.error("[roles] franchise_rosters sync failed:", res.error); }
    }
  }

  lines.push(`Team roles: ${apply ? "" : "would "}add ${created} / move ${moved}`);
  if (conflicts.length > 0) lines.push(`Skipped (more than one team role): ${conflicts.join(", ")}`);
  if (noFranchise.size > 0) lines.push(`No franchise matches: ${Array.from(noFranchise).join(", ")}`);
  return { lines, failed };
}

/**
 * Mirrors the Discord server onto the league. With apply=false nothing is
 * written. Deletion of people who left only happens when apply AND
 * options.removeLeavers are both true.
 */
export async function syncLeagueRoles(
  leagueId: string,
  guildId: string,
  apply: boolean,
  options: LeagueSyncOptions = {}
): Promise<LeagueSyncResult> {
  const removeLeavers = options.removeLeavers === true;

  const mappings = await loadMappings(leagueId);
  const managed = MAPPABLE_FLAGS.filter((f) => mappings.some((m) => m.flag === f));
  const rolesForFlag = (flag: MappableFlag) =>
    mappings.filter((m) => m.flag === flag).map((m) => m.discord_role_id);

  const fetched = await fetchGuildMembers(guildId);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const guildMembers = fetched.members;

  // An empty member list means the fetch is wrong, not that everyone left.
  if (guildMembers.size === 0) {
    return { ok: false, error: "Discord returned no members, so nothing was changed." };
  }

  const roleNames = await fetchRoleNames(guildId);
  if (!roleNames.ok) return { ok: false, error: roleNames.error };

  const { data, error } = await db()
    .from("driver_leagues")
    .select(
      `id, driver_id, discord_roles, is_owner, ${MAPPABLE_FLAGS.join(", ")}, drivers:driver_id(discord_id, display_name, discord_username)`
    )
    .eq("league_id", leagueId)
    .range(0, 4999);
  if (error) {
    console.error("[roles] sync load members failed:", error);
    return { ok: false, error: `Couldn't load league members: ${error.message}` };
  }

  const rows = (data ?? []) as MemberRow[];

  const rolesSnapshot = (roleIds: string[]): StoredRole[] =>
    roleIds
      .filter((id) => id !== guildId)
      .map((id) => ({ id, name: roleNames.names.get(id) ?? "" }));

  const changes: LeagueSyncChange[] = [];
  const removals: { id: string; name: string }[] = [];
  const keptStaff: string[] = [];
  const additions: { discordId: string; member: GuildMember }[] = [];

  const granted: Record<string, number> = {};
  const removedFlag: Record<string, number> = {};
  let roleListsUpdated = 0;
  const knownDiscordIds = new Set<string>();

  for (const row of rows) {
    const d = Array.isArray(row.drivers) ? row.drivers[0] : row.drivers;
    const discordId = d?.discord_id;
    if (!discordId) continue;
    knownDiscordIds.add(discordId);

    const name = d?.display_name || d?.discord_username || discordId;
    const member = guildMembers.get(discordId);

    // Left or banned. Staff are never deleted, only reported.
    if (!member) {
      const protectedRow = MANAGER_FLAGS.some((f) => row[f] === true);
      if (protectedRow) keptStaff.push(name);
      else removals.push({ id: row.id, name });
      continue;
    }

    const patch: Record<string, unknown> = {};
    const notes: string[] = [];

    for (const flag of managed) {
      if (isPinned(leagueId, discordId, flag)) continue;
      const want = rolesForFlag(flag).some((r) => member.roles.includes(r));
      const have = row[flag] === true;
      if (want !== have) {
        patch[flag] = want;
        notes.push(`${want ? "+" : "−"}${FLAG_LABEL[flag]}`);
        if (want) granted[flag] = (granted[flag] ?? 0) + 1;
        else removedFlag[flag] = (removedFlag[flag] ?? 0) + 1;
      }
    }

    const current = rolesSnapshot(member.roles);
    if (!sameRoles(current, normaliseStored(row.discord_roles))) {
      patch.discord_roles = current;
      roleListsUpdated++;
      notes.push(`roles (${current.length})`);
    }

    if (notes.length > 0) changes.push({ id: row.id, name, patch, notes });
  }

  // Everyone in the server who isn't in this league yet.
  guildMembers.forEach((member, discordId) => {
    if (!knownDiscordIds.has(discordId)) additions.push({ discordId, member });
  });

  const summary = managed.map(
    (flag) => `${FLAG_LABEL[flag]}: +${granted[flag] ?? 0} / −${removedFlag[flag] ?? 0}`
  );
  summary.push(`Role lists updated: ${roleListsUpdated}`);
  summary.push(`Added to league: ${additions.length}`);
  summary.push(
    `${removeLeavers && apply ? "Removed" : "Would remove"} (left or banned): ${removals.length}`
  );
  if (managed.length === 0) {
    summary.push("No roles are mapped to permissions yet, so flags were not touched.");
  }

  let applied = 0;
  let added = 0;
  let removed = 0;
  let failed = 0;

  if (apply) {
    // 1. Flag and role-snapshot updates for existing members.
    for (const group of chunk(changes, 10)) {
      const results = await Promise.all(
        group.map((c) => db().from("driver_leagues").update(c.patch).eq("id", c.id))
      );
      for (const r of results) {
        if (r.error) {
          failed++;
          console.error("[roles] sync update failed:", r.error);
        } else {
          applied++;
        }
      }
    }

    // 2. Add server members who aren't in the league: reuse an existing
    //    drivers row, otherwise create one.
    if (additions.length > 0) {
      const driverIdByDiscord = new Map<string, string>();

      for (const group of chunk(additions, 100)) {
        const { data: found, error: findError } = await db()
          .from("drivers")
          .select("id, discord_id")
          .in(
            "discord_id",
            group.map((a) => a.discordId)
          );
        if (findError) {
          console.error("[roles] driver lookup failed:", findError);
          continue;
        }
        for (const d of (found ?? []) as { id: string; discord_id: string }[]) {
          driverIdByDiscord.set(d.discord_id, d.id);
        }
      }

      const missing = additions.filter((a) => !driverIdByDiscord.has(a.discordId));
      for (const group of chunk(missing, 100)) {
        const { data: created, error: createError } = await db()
          .from("drivers")
          .insert(
            group.map((a) => ({
              discord_id: a.discordId,
              discord_username: a.member.username,
              display_name: a.member.displayName,
            }))
          )
          .select("id, discord_id");
        if (createError) {
          failed += group.length;
          console.error("[roles] driver create failed:", createError);
          continue;
        }
        for (const d of (created ?? []) as { id: string; discord_id: string }[]) {
          driverIdByDiscord.set(d.discord_id, d.id);
        }
      }

      const membershipRows = additions
        .filter((a) => driverIdByDiscord.has(a.discordId))
        .map((a) => {
          const row: Record<string, unknown> = {
            driver_id: driverIdByDiscord.get(a.discordId),
            league_id: leagueId,
            discord_roles: rolesSnapshot(a.member.roles),
          };
          for (const flag of managed) {
            row[flag] = rolesForFlag(flag).some((r) => a.member.roles.includes(r));
          }
          return row;
        });

      for (const group of chunk(membershipRows, 100)) {
        const { error: insError } = await db()
          .from("driver_leagues")
          .upsert(group, { onConflict: "driver_id,league_id", ignoreDuplicates: true });
        if (insError) {
          failed += group.length;
          console.error("[roles] membership insert failed:", insError);
        } else {
          added += group.length;
        }
      }
    }

    // 3. Remove people who left or were banned (membership row only; the
    //    drivers row and all history are kept). Only when explicitly asked.
    if (removeLeavers && removals.length > 0) {
      for (const group of chunk(removals, 100)) {
        const { error: delError } = await db()
          .from("driver_leagues")
          .delete()
          .in(
            "id",
            group.map((g) => g.id)
          );
        if (delError) {
          failed += group.length;
          console.error("[roles] membership delete failed:", delError);
        } else {
          removed += group.length;
        }
      }
    }
  }

  const teamSync = await syncTeamRoles(
    leagueId,
    roleNames.names,
    rows.flatMap((row) => {
      const d = Array.isArray(row.drivers) ? row.drivers[0] : row.drivers;
      const member = d?.discord_id ? guildMembers.get(d.discord_id) : undefined;
      if (!member) return [];
      const patched = changes.find((c) => c.id === row.id)?.patch.is_team_principal;
      return [{
        driverId: row.driver_id,
        name: d?.display_name || d?.discord_username || d?.discord_id || row.driver_id,
        roleIds: member.roles,
        isTeamPrincipal: typeof patched === "boolean" ? patched : row.is_team_principal === true,
      }];
    }),
    apply
  );
  summary.push(...teamSync.lines);
  failed += teamSync.failed;

  const footer: string[] = [];
  if (keptStaff.length > 0) {
    footer.push(
      `Not in the server but kept because they're owner/co-owner/commissioner: ${keptStaff.join(", ")}.`
    );
  }
  if (removals.length > 0 && !(removeLeavers && apply)) {
    footer.push(
      `${removals.length} member(s) left or were banned. Run \`/roles sync apply:true\` to remove them from the league.`
    );
  }

  return {
    ok: true,
    changes,
    additions: additions.map((a) => a.member.displayName),
    removals: removals.map((r) => r.name),
    keptStaff,
    summary,
    footer,
    applied,
    added,
    removed,
    failed,
  };
}

registerCommand("roles_sync", async (ctx) => {
  const denied = await requireManager(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const leagueId = ctx.leagueId as string;
  const guildId = ctx.guildId;
  if (!guildId) return { content: "Run this inside the league's server.", ephemeral: true };

  const apply = ctx.options.apply === true;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      // The command is the one place deletion is allowed, and only with apply.
      const result = await syncLeagueRoles(leagueId, guildId, apply, { removeLeavers: apply });
      if (!result.ok) return { content: result.error };

      const { changes, additions, removals, summary, footer, applied, added, removed, failed } = result;

      const total = changes.length + additions.length + removals.length;
      if (total === 0) {
        return {
          content: ["The league already matches the server. Nothing to change.", ...footer]
            .join("\n")
            .slice(0, DISCORD_MAX),
        };
      }

      const list = (label: string, items: string[]) =>
        items.length === 0
          ? ""
          : `**${label}**\n` +
            items.slice(0, 8).map((s) => `• ${s}`).join("\n") +
            (items.length > 8 ? `\n…and ${items.length - 8} more.` : "");

      const sections = [
        list("Updated", changes.map((c) => `${c.name}: ${c.notes.join(", ")}`)),
        list("Added", additions),
        list("Removed", removals),
      ].filter(Boolean);

      const truncate = (text: string) =>
        text.length > DISCORD_MAX ? text.slice(0, DISCORD_MAX - 1) + "…" : text;

      if (!apply) {
        return {
          content: truncate(
            [
              `**Preview** — ${total} change(s). Nothing written.`,
              summary.join("\n"),
              "",
              sections.join("\n\n"),
              "",
              "Run `/roles sync apply:true` to apply (this also removes people who left or were banned).",
              ...footer,
            ].join("\n")
          ),
        };
      }

      return {
        content: truncate(
          [
            `**Synced** — ${applied} updated, ${added} added, ${removed} removed${
              failed ? `, ${failed} failed (run it again)` : ""
            }.`,
            summary.join("\n"),
            "",
            sections.join("\n\n"),
            ...footer,
          ].join("\n")
        ),
      };
    },
  };
});
