import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Discord role -> PitBoss permission flag mapping.
//
//   /roles map   role:@X flag:...   link a Discord role to a flag
//   /roles unmap role:@X [flag]     remove a link (all flags for the role if omitted)
//   /roles list                     show the current mapping
//   /roles sync  [apply]            mirror Discord roles onto pitboss.driver_leagues
//
// Dispatch keys: roles_map / roles_unmap / roles_list / roles_sync.
//
// Automatic syncing (no command needed):
//  1. syncMemberRoles() — called from the command router on every slash
//     command in a guild, BEFORE the permission check. It reads the roles
//     Discord already put on the interaction and fixes that one member's
//     flags, so a new or removed role takes effect the next time they use
//     the bot.
//  2. syncLeagueRoles() — called by /api/cron/roles-sync on a schedule to
//     mirror every member, so people who haven't used the bot (and the web
//     app) stay correct too.
//
// Sync rules:
//  - Only flags that have at least one mapping are managed. Flags with no
//    mapping are never touched.
//  - For a managed flag, a member gets it if they hold ANY role mapped to it,
//    and loses it if they hold none (so removing a role removes the flag).
//  - is_owner is never mappable and never changed by a sync.
//  - Members who are in PitBoss but no longer in the Discord server are left
//    alone by the bulk sync.
//  - /roles sync defaults to a preview; pass apply:true to write changes.
//    The scheduled and per-command syncs always apply.
//
// Tables: pitboss.league_role_map (league_id, discord_role_id, flag),
//         pitboss.driver_leagues (the flags).
//
// Who can run /roles: owner / co-owner / commissioner, or a Discord
// Administrator (so a brand-new league's owner can bootstrap it).

const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR = BigInt(1) << BigInt(3);

const MANAGER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;

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

function db() {
  // Untyped on purpose: flag columns are written by computed key.
  return (createAdminClient() as any).schema("pitboss");
}

function isMappableFlag(value: unknown): value is MappableFlag {
  return typeof value === "string" && (MAPPABLE_FLAGS as readonly string[]).includes(value);
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

async function fetchGuildRoles(
  guildId: string
): Promise<{ ok: true; members: Map<string, string[]> } | { ok: false; error: string }> {
  const members = new Map<string, string[]>();
  let after = "0";

  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
      headers: { Authorization: `Bot ${process.env.PITBOSS_DISCORD_BOT_TOKEN}` },
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
      user?: { id: string; bot?: boolean };
      roles?: string[];
    }[];

    for (const m of batch) {
      if (!m.user || m.user.bot) continue;
      members.set(m.user.id, m.roles ?? []);
    }

    if (batch.length < 1000) return { ok: true, members };
    after = batch[batch.length - 1].user?.id ?? after;
  }

  return { ok: false, error: "The server has too many members to sync in one pass." };
}

interface MemberRow {
  id: string;
  driver_id: string;
  drivers:
    | { discord_id: string | null; display_name: string | null; discord_username: string | null }
    | { discord_id: string | null; display_name: string | null; discord_username: string | null }[]
    | null;
  [flag: string]: unknown;
}

export interface LeagueSyncChange {
  id: string;
  name: string;
  patch: Record<string, boolean>;
  notes: string[];
}

export type LeagueSyncResult =
  | { ok: false; error: string }
  | {
      ok: true;
      changes: LeagueSyncChange[];
      summary: string[];
      footer: string[];
      applied: number;
      failed: number;
    };

/**
 * Mirrors Discord roles onto driver_leagues flags for one league. With
 * apply=false nothing is written and `applied` is 0.
 */
export async function syncLeagueRoles(
  leagueId: string,
  guildId: string,
  apply: boolean
): Promise<LeagueSyncResult> {
  const mappings = await loadMappings(leagueId);
  if (mappings.length === 0) {
    return { ok: false, error: "No roles are mapped yet. Use `/roles map` first." };
  }

  const managed = MAPPABLE_FLAGS.filter((f) => mappings.some((m) => m.flag === f));
  const rolesForFlag = (flag: MappableFlag) =>
    mappings.filter((m) => m.flag === flag).map((m) => m.discord_role_id);

  const fetched = await fetchGuildRoles(guildId);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const guildMembers = fetched.members;

  const { data, error } = await db()
    .from("driver_leagues")
    .select(
      `id, driver_id, ${MAPPABLE_FLAGS.join(", ")}, drivers:driver_id(discord_id, display_name, discord_username)`
    )
    .eq("league_id", leagueId)
    .range(0, 4999);
  if (error) {
    console.error("[roles] sync load members failed:", error);
    return { ok: false, error: `Couldn't load league members: ${error.message}` };
  }

  const rows = (data ?? []) as MemberRow[];

  const changes: LeagueSyncChange[] = [];
  const granted: Record<string, number> = {};
  const removed: Record<string, number> = {};
  let notInServer = 0;
  const knownDiscordIds = new Set<string>();

  for (const row of rows) {
    const d = Array.isArray(row.drivers) ? row.drivers[0] : row.drivers;
    const discordId = d?.discord_id;
    if (!discordId) continue;
    knownDiscordIds.add(discordId);

    const roles = guildMembers.get(discordId);
    if (!roles) {
      notInServer++;
      continue;
    }

    const patch: Record<string, boolean> = {};
    const notes: string[] = [];
    for (const flag of managed) {
      const want = rolesForFlag(flag).some((r) => roles.includes(r));
      const have = row[flag] === true;
      if (want !== have) {
        patch[flag] = want;
        notes.push(`${want ? "+" : "−"}${FLAG_LABEL[flag]}`);
        if (want) granted[flag] = (granted[flag] ?? 0) + 1;
        else removed[flag] = (removed[flag] ?? 0) + 1;
      }
    }

    if (notes.length > 0) {
      changes.push({
        id: row.id,
        name: d?.display_name || d?.discord_username || discordId,
        patch,
        notes,
      });
    }
  }

  let missingFromPitboss = 0;
  guildMembers.forEach((_roles, discordId) => {
    if (!knownDiscordIds.has(discordId)) missingFromPitboss++;
  });

  const summary = managed.map(
    (flag) => `${FLAG_LABEL[flag]}: +${granted[flag] ?? 0} / −${removed[flag] ?? 0}`
  );

  const footer: string[] = [];
  if (notInServer > 0) footer.push(`${notInServer} in PitBoss but not in the server (left alone).`);
  if (missingFromPitboss > 0) {
    footer.push(`${missingFromPitboss} server members aren't in this league yet — run \`/members-sync\`.`);
  }

  let failed = 0;
  let applied = 0;
  if (apply) {
    for (let i = 0; i < changes.length; i += 10) {
      const chunk = changes.slice(i, i + 10);
      const results = await Promise.all(
        chunk.map((c) => db().from("driver_leagues").update(c.patch).eq("id", c.id))
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
  }

  return { ok: true, changes, summary, footer, applied, failed };
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
      const result = await syncLeagueRoles(leagueId, guildId, apply);
      if (!result.ok) return { content: result.error };

      const { changes, summary, footer, applied, failed } = result;

      if (changes.length === 0) {
        return {
          content: ["Flags already match Discord roles. Nothing to change.", ...footer].join("\n"),
        };
      }

      const sample = changes
        .slice(0, 12)
        .map((c) => `• ${c.name}: ${c.notes.join(", ")}`)
        .join("\n");
      const more = changes.length > 12 ? `\n…and ${changes.length - 12} more.` : "";

      if (!apply) {
        return {
          content: [
            `**Preview** — ${changes.length} member(s) would change. Nothing written.`,
            summary.join("\n"),
            "",
            sample + more,
            "",
            "Run `/roles sync apply:true` to apply now. Otherwise this happens automatically.",
            ...footer,
          ].join("\n"),
        };
      }

      return {
        content: [
          `**Synced** — updated ${applied} member(s)${failed ? `, ${failed} failed (run it again)` : ""}.`,
          summary.join("\n"),
          "",
          sample + more,
          ...footer,
        ].join("\n"),
      };
    },
  };
});
