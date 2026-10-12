// src/lib/discord/commands/members-sync.ts
//
// /members-sync — pulls the Discord server's member list into PitBoss so
// features that read pitboss.driver_leagues (season signups, etc.) can see
// everyone in the server, not just drivers who were added by hand.
//
// For each human member (bots skipped) it:
//   1. finds or creates the pitboss.drivers row (unique on discord_id)
//   2. adds a pitboss.driver_leagues row for this league if missing
//      (unique on driver_id+league_id; existing rows and their owner/steward
//      flags are never touched)
//
// Options:
//   role   (optional, Discord role) only sync members who have this role —
//          use it to run a small test group first
//   apply  (optional boolean, default false) false = preview only, writes
//          nothing; true = actually create/add
//
// Who can run it: league owner/co-owner/commissioner, OR anyone with Discord
// Administrator / Manage Server in the invoking server. The Discord fallback
// exists so a brand-new league with no driver_leagues rows can bootstrap.
//
// Requires the PitBoss bot to have the "Server Members Intent" enabled in the
// Discord developer portal, otherwise GET /guilds/{id}/members returns 403.

import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const OWNER_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;
const MAX_PAGES = 10; // 10 x 1000 = 10k members, plenty of headroom
const CHUNK = 100;

interface GuildMember {
  user?: { id: string; username: string; global_name?: string | null; bot?: boolean };
  nick?: string | null;
  roles: string[];
}

// Discord permissions arrive as a stringified bitfield. Bits used here sit
// well under 2^53, so Number math is exact; avoiding BigInt keeps this
// compiling under the project's current TS target.
function hasDiscordAdmin(permissions: string): boolean {
  const p = Number(permissions);
  if (!Number.isFinite(p)) return false;
  const administrator = p % 16 >= 8; // bit 3 (0x8)
  const manageGuild = p % 64 >= 32; // bit 5 (0x20)
  return administrator || manageGuild;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchGuildMembers(
  token: string,
  guildId: string
): Promise<{ members: GuildMember[] } | { error: string }> {
  const members: GuildMember[] = [];
  let after = "0";

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${DISCORD_API_BASE}/guilds/${guildId}/members?limit=1000&after=${after}`,
      { headers: { Authorization: `Bot ${token}` } }
    );

    if (res.status === 429) {
      const json = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((json.retry_after ?? 1) * 1000) + 250));
      page--; // retry the same page
      continue;
    }
    if (res.status === 403) {
      return {
        error:
          "Discord refused the member list (403). Turn on **Server Members Intent** for the PitBoss bot in the Discord developer portal, then try again.",
      };
    }
    if (!res.ok) {
      return { error: `Discord returned ${res.status} fetching members: ${await res.text()}` };
    }

    const batch = (await res.json()) as GuildMember[];
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user?.id ?? after;
  }

  return { members };
}

registerCommand("members-sync", async (ctx) => {
  const leagueId = ctx.leagueId;
  const guildId = ctx.guildId;
  if (!leagueId || !guildId) {
    return { content: "This command must be used in a league's Discord server.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  const allowed =
    hasAnyFlag(membership, [...OWNER_FLAGS]) || hasDiscordAdmin(ctx.memberPermissions ?? "0");
  if (!allowed) {
    return {
      content: "Only league owners or server admins (Administrator / Manage Server) can sync members.",
      ephemeral: true,
    };
  }

  const roleId = ctx.options.role as string | undefined;
  const apply = Boolean(ctx.options.apply);

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
      if (!token) return { content: "PITBOSS_DISCORD_BOT_TOKEN not set — can't read the server." };

      const fetched = await fetchGuildMembers(token, guildId);
      if ("error" in fetched) return { content: fetched.error };

      const all = fetched.members;
      const humans = all.filter((m) => m.user && !m.user.bot);
      const targets = roleId ? humans.filter((m) => m.roles.includes(roleId)) : humans;

      if (targets.length === 0) {
        return {
          content: roleId
            ? `Nobody in this server has that role (server has ${humans.length} human member(s)).`
            : "No human members found.",
        };
      }

      const supabase = createAdminClient();
      const discordIds = targets.map((m) => m.user!.id);

      // 1) Existing drivers
      const existingDrivers = new Map<string, string>(); // discord_id -> driver id
      for (const ids of chunk(discordIds, CHUNK)) {
        const { data, error } = await supabase
          .schema("pitboss")
          .from("drivers")
          .select("id, discord_id")
          .in("discord_id", ids);
        if (error) return { content: `Couldn't look up existing drivers: ${error.message}` };
        for (const d of data ?? []) existingDrivers.set(d.discord_id as string, d.id as string);
      }

      const newMembers = targets.filter((m) => !existingDrivers.has(m.user!.id));

      // 2) Existing league memberships (for drivers that already exist)
      const alreadyInLeague = new Set<string>(); // driver id
      const existingDriverIds = [...existingDrivers.values()];
      for (const ids of chunk(existingDriverIds, CHUNK)) {
        const { data, error } = await supabase
          .schema("pitboss")
          .from("driver_leagues")
          .select("driver_id")
          .eq("league_id", leagueId)
          .in("driver_id", ids);
        if (error) return { content: `Couldn't look up league members: ${error.message}` };
        for (const r of data ?? []) alreadyInLeague.add(r.driver_id as string);
      }

      const toAddExisting = existingDriverIds.filter((id) => !alreadyInLeague.has(id));
      const willAdd = newMembers.length + toAddExisting.length;

      const summary = [
        `Server members: ${all.length} total, ${all.length - humans.length} bot(s) skipped` +
          (roleId ? `, ${targets.length} with the chosen role.` : "."),
        `Already in this league: ${alreadyInLeague.size}`,
        `Existing PitBoss drivers to add to the league: ${toAddExisting.length}`,
        `New driver profiles to create (and add): ${newMembers.length}`,
      ];

      if (!apply) {
        summary.push(
          willAdd === 0
            ? "Nothing to do."
            : `Preview only — nothing was written. Re-run with \`apply: true\` to add ${willAdd} member(s).`
        );
        return { content: summary.join("\n") };
      }

      // 3) Create new drivers (unique on discord_id; ignore races/dupes)
      if (newMembers.length > 0) {
        for (const batch of chunk(newMembers, CHUNK)) {
          const rows = batch.map((m) => ({
            discord_id: m.user!.id,
            discord_username: m.user!.username,
            display_name: m.nick ?? m.user!.global_name ?? null,
          }));
          const { error } = await supabase
            .schema("pitboss")
            .from("drivers")
            .upsert(rows, { onConflict: "discord_id", ignoreDuplicates: true });
          if (error) return { content: `Couldn't create driver profiles: ${error.message}` };
        }

        // Re-read ids for the newly created drivers
        const newIds = newMembers.map((m) => m.user!.id);
        for (const ids of chunk(newIds, CHUNK)) {
          const { data, error } = await supabase
            .schema("pitboss")
            .from("drivers")
            .select("id, discord_id")
            .in("discord_id", ids);
          if (error) return { content: `Created profiles but couldn't read them back: ${error.message}` };
          for (const d of data ?? []) existingDrivers.set(d.discord_id as string, d.id as string);
        }
      }

      // 4) Add league membership rows (flags/role take table defaults; this
      //    only makes them members — it does not mark anyone as a driver,
      //    steward, or owner).
      const memberDriverIds = [
        ...toAddExisting,
        ...newMembers
          .map((m) => existingDrivers.get(m.user!.id))
          .filter((id): id is string => Boolean(id)),
      ];

      let added = 0;
      for (const ids of chunk(memberDriverIds, CHUNK)) {
        const rows = ids.map((driver_id) => ({ driver_id, league_id: leagueId }));
        const { error } = await supabase
          .schema("pitboss")
          .from("driver_leagues")
          .upsert(rows, { onConflict: "driver_id,league_id", ignoreDuplicates: true });
        if (error) {
          return {
            content: `Added ${added} before an error: ${error.message}. Re-run to continue — it's safe to repeat.`,
          };
        }
        added += ids.length;
      }

      summary.push(`Done — added ${added} member(s) to this league. Safe to re-run any time.`);
      return { content: summary.join("\n") };
    },
  };
});
