import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import { getOrCreateDriver } from "./checkin";

// /division create | list | assign | remove | link | delete
//
// Divisions live in rise_os.league_divisions — the same table check-in
// already resolves against (resolveDivision / resolveDivisionByChannel in
// checkin.ts). Creating a division here is what makes check-in recognize
// it: /checkin-create takes the division code, and the check-in channel
// registered on the row scopes /checkin, /checkin-status, etc.
//
// Driver membership lives in pitboss.division_members (one active
// division per driver per league). pitboss and rise_os are separate
// PostgREST schemas, so there are NO cross-schema embeds anywhere in this
// file — every join is done as two queries and merged in memory.
//
// Column notes on rise_os.league_divisions:
//   discord_checkin_channel_id  -> the division's check-in text channel
//   discord_checkin_role_id     -> the division's Discord role
//   discord_category_id         -> the category holding the channel(s)

const DISCORD_API_BASE = "https://discord.com/api/v10";

const DIVISION_ADMIN_FLAGS = ["is_owner", "is_co_owner", "is_commissioner"] as const;

type DiscordResult =
  | { ok: true; data: any }
  | { ok: false; status: number; error: string };

async function discordRequest(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<DiscordResult> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    return { ok: false, status: 0, error: "PITBOSS_DISCORD_BOT_TOKEN not set" };
  }
  try {
    const res = await fetch(`${DISCORD_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    const data = res.status === 204 ? null : await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

async function isDivisionAdmin(discordUserId: string, leagueId: string) {
  const membership = await getLeagueMembership(discordUserId, leagueId);
  return hasAnyFlag(membership, [...DIVISION_ADMIN_FLAGS]);
}

function cleanCode(raw: unknown): string | null {
  const code = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z0-9_-]{1,12}$/.test(code) ? code : null;
}

function channelSlug(code: string) {
  return `${code.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-check-in`;
}

const DIVISION_COLUMNS =
  "id, league_id, division_code, division_name, discord_checkin_channel_id, discord_checkin_role_id, discord_category_id, max_drivers, tier_order";

async function findDivision(leagueId: string, code: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select(DIVISION_COLUMNS)
    .eq("league_id", leagueId)
    .ilike("division_code", code)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) return { error: `No division "${code}" in this league.` } as const;
  return { division: data } as const;
}

async function countActiveMembers(divisionId: string) {
  const supabase = createAdminClient();
  const { count } = await supabase
    .schema("pitboss")
    .from("division_members")
    .select("id", { count: "exact", head: true })
    .eq("division_id", divisionId)
    .eq("active", true);
  return count ?? 0;
}

// ---------------------------------------------------------------------
// /division create
// ---------------------------------------------------------------------
registerCommand("division_create", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }
  if (!(await isDivisionAdmin(ctx.discordUserId, leagueId))) {
    return { content: "You don't have permission to create divisions.", ephemeral: true };
  }

  const code = cleanCode(ctx.options.code);
  if (!code) {
    return {
      content: "Division code must be 1-12 characters: letters, numbers, `-` or `_` (e.g. D1, F2, PRO).",
      ephemeral: true,
    };
  }

  const guildId = ctx.guildId;
  const displayName = (ctx.options.name as string | undefined)?.trim() || code;
  const maxDrivers = ctx.options.max_drivers as number | undefined;
  const tierOrderInput = ctx.options.tier_order as number | undefined;
  const createDiscord = ctx.options.create_discord !== false; // default: yes

  if (createDiscord && !guildId) {
    return { content: "Can't create Discord role/channels outside a server.", ephemeral: true };
  }

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const existing = await findDivision(leagueId, code);
      if (!("error" in existing)) {
        return { content: `Division **${code}** already exists in this league. Use \`/division link\` to change its channel or role.` };
      }

      const supabase = createAdminClient();

      let tierOrder = tierOrderInput;
      if (tierOrder == null) {
        const { count } = await supabase
          .schema("rise_os")
          .from("league_divisions")
          .select("id", { count: "exact", head: true })
          .eq("league_id", leagueId);
        tierOrder = (count ?? 0) + 1;
      }

      let roleId: string | null = null;
      let categoryId: string | null = null;
      let channelId: string | null = null;
      const warnings: string[] = [];

      if (createDiscord && guildId) {
        const role = await discordRequest("POST", `/guilds/${guildId}/roles`, {
          name: displayName,
          mentionable: true,
        });
        if (!role.ok) {
          return { content: `Couldn't create the Discord role (${role.status}). Check the bot has Manage Roles. ${role.error}`.slice(0, 1800) };
        }
        roleId = role.data.id;

        const category = await discordRequest("POST", `/guilds/${guildId}/channels`, {
          name: displayName,
          type: 4,
        });
        if (!category.ok) {
          await discordRequest("DELETE", `/guilds/${guildId}/roles/${roleId}`);
          return { content: `Couldn't create the category (${category.status}). Check the bot has Manage Channels. ${category.error}`.slice(0, 1800) };
        }
        categoryId = category.data.id;

        const channel = await discordRequest("POST", `/guilds/${guildId}/channels`, {
          name: channelSlug(code),
          type: 0,
          parent_id: categoryId,
        });
        if (!channel.ok) {
          await discordRequest("DELETE", `/channels/${categoryId}`);
          await discordRequest("DELETE", `/guilds/${guildId}/roles/${roleId}`);
          return { content: `Couldn't create the check-in channel (${channel.status}). ${channel.error}`.slice(0, 1800) };
        }
        channelId = channel.data.id;
      }

      const { error: insertError } = await supabase
        .schema("rise_os")
        .from("league_divisions")
        .insert({
          league_id: leagueId,
          division_code: code,
          division_name: displayName,
          discord_checkin_channel_id: channelId,
          discord_checkin_role_id: roleId,
          discord_category_id: categoryId,
          max_drivers: maxDrivers ?? null,
          tier_order: tierOrder,
        });

      if (insertError) {
        console.error("[division_create] insert failed:", insertError);
        // Roll back the Discord objects so we don't leave orphans behind.
        if (guildId) {
          if (channelId) await discordRequest("DELETE", `/channels/${channelId}`);
          if (categoryId) await discordRequest("DELETE", `/channels/${categoryId}`);
          if (roleId) await discordRequest("DELETE", `/guilds/${guildId}/roles/${roleId}`);
        }
        return { content: `Couldn't save the division: ${insertError.message}` };
      }

      const lines = [`Division **${code}** created${displayName !== code ? ` (${displayName})` : ""}.`];
      if (channelId) lines.push(`Check-in channel: <#${channelId}>`);
      if (roleId) lines.push(`Role: <@&${roleId}>`);
      if (maxDrivers) lines.push(`Max drivers: ${maxDrivers}`);
      if (!createDiscord) {
        lines.push("No Discord objects created. Use `/division link` to attach a channel and role before running `/checkin-create`.");
      } else {
        lines.push(`Next: \`/checkin-create division:${code}\` to post a check-in, and \`/division assign\` to add drivers.`);
      }
      lines.push(...warnings);
      return { content: lines.join("\n") };
    },
  };
});

// ---------------------------------------------------------------------
// /division list
// ---------------------------------------------------------------------
registerCommand("division_list", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const { data: divisions, error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select(DIVISION_COLUMNS)
    .eq("league_id", leagueId)
    .order("tier_order", { ascending: true });

  if (error) {
    console.error("[division_list] lookup failed:", error);
    return { content: `Something went wrong pulling divisions: ${error.message}`, ephemeral: true };
  }
  if (!divisions || divisions.length === 0) {
    return { content: "No divisions set up for this league yet. Use `/division create`.", ephemeral: true };
  }

  const { data: members } = await supabase
    .schema("pitboss")
    .from("division_members")
    .select("division_id")
    .eq("league_id", leagueId)
    .eq("active", true);

  const counts = new Map<string, number>();
  for (const m of members ?? []) {
    counts.set(m.division_id, (counts.get(m.division_id) ?? 0) + 1);
  }

  const lines = ["**Divisions**"];
  for (const d of divisions) {
    const count = counts.get(d.id) ?? 0;
    const cap = d.max_drivers ? `${count}/${d.max_drivers}` : `${count}`;
    const name = d.division_name && d.division_name !== d.division_code ? ` — ${d.division_name}` : "";
    const channel = d.discord_checkin_channel_id ? `<#${d.discord_checkin_channel_id}>` : "no check-in channel";
    const role = d.discord_checkin_role_id ? ` · <@&${d.discord_checkin_role_id}>` : "";
    lines.push(`**${d.division_code}**${name} · ${cap} drivers · ${channel}${role}`);
  }

  return { content: lines.join("\n"), ephemeral: true };
});

// ---------------------------------------------------------------------
// /division assign
// ---------------------------------------------------------------------
registerCommand("division_assign", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }
  if (!(await isDivisionAdmin(ctx.discordUserId, leagueId))) {
    return { content: "You don't have permission to assign divisions.", ephemeral: true };
  }

  const targetId = ctx.options.driver as string | undefined;
  const code = cleanCode(ctx.options.division);
  if (!targetId || !code) {
    return { content: "driver and division are required.", ephemeral: true };
  }

  const divisionResult = await findDivision(leagueId, code);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Couldn't find that division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const driverResult = await getOrCreateDriver(targetId, ctx.resolvedUsers[targetId]?.username);
  if ("error" in driverResult) {
    return { content: `Couldn't resolve the driver record: ${driverResult.error}`, ephemeral: true };
  }
  const driverId = driverResult.driver.id;

  const supabase = createAdminClient();

  const { data: current, error: currentError } = await supabase
    .schema("pitboss")
    .from("division_members")
    .select("id, division_id")
    .eq("driver_id", driverId)
    .eq("league_id", leagueId)
    .eq("active", true)
    .maybeSingle();

  if (currentError) {
    console.error("[division_assign] membership lookup failed:", currentError);
    return { content: `Something went wrong: ${currentError.message}`, ephemeral: true };
  }
  if (current && current.division_id === division.id) {
    return { content: `<@${targetId}> is already in Division ${division.division_code}.`, ephemeral: true };
  }

  if (division.max_drivers) {
    const count = await countActiveMembers(division.id);
    if (count >= division.max_drivers) {
      return {
        content: `Division ${division.division_code} is full (${count}/${division.max_drivers}). Raise the cap with \`/division link\` or remove someone first.`,
        ephemeral: true,
      };
    }
  }

  let previousDivision: { division_code: string; discord_checkin_role_id: string | null } | null = null;
  if (current) {
    const { data: prev } = await supabase
      .schema("rise_os")
      .from("league_divisions")
      .select("division_code, discord_checkin_role_id")
      .eq("id", current.division_id)
      .maybeSingle();
    previousDivision = prev ?? null;

    const { error: deactivateError } = await supabase
      .schema("pitboss")
      .from("division_members")
      .update({ active: false })
      .eq("id", current.id);
    if (deactivateError) {
      console.error("[division_assign] deactivate failed:", deactivateError);
      return { content: `Couldn't move the driver: ${deactivateError.message}`, ephemeral: true };
    }
  }

  const { error: insertError } = await supabase
    .schema("pitboss")
    .from("division_members")
    .insert({
      division_id: division.id,
      driver_id: driverId,
      league_id: leagueId,
      assigned_by: ctx.discordUserId,
    });

  if (insertError) {
    console.error("[division_assign] insert failed:", insertError);
    if (current) {
      await supabase.schema("pitboss").from("division_members").update({ active: true }).eq("id", current.id);
    }
    return { content: `Couldn't assign the driver: ${insertError.message}`, ephemeral: true };
  }

  const notes: string[] = [];
  const guildId = ctx.guildId;
  if (guildId) {
    if (previousDivision?.discord_checkin_role_id) {
      const removed = await discordRequest(
        "DELETE",
        `/guilds/${guildId}/members/${targetId}/roles/${previousDivision.discord_checkin_role_id}`
      );
      if (!removed.ok) notes.push(`Couldn't remove the old ${previousDivision.division_code} role (${removed.status}).`);
    }
    if (division.discord_checkin_role_id) {
      const granted = await discordRequest(
        "PUT",
        `/guilds/${guildId}/members/${targetId}/roles/${division.discord_checkin_role_id}`
      );
      if (!granted.ok) notes.push(`Couldn't grant the ${division.division_code} role (${granted.status}) — is the driver in this server?`);
    } else {
      notes.push(`Division ${division.division_code} has no role linked yet (\`/division link\`).`);
    }
  }

  const moved = previousDivision ? ` (moved from ${previousDivision.division_code})` : "";
  return {
    content: [`<@${targetId}> assigned to Division **${division.division_code}**${moved}.`, ...notes].join("\n"),
    ephemeral: true,
  };
});

// ---------------------------------------------------------------------
// /division remove
// ---------------------------------------------------------------------
registerCommand("division_remove", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }
  if (!(await isDivisionAdmin(ctx.discordUserId, leagueId))) {
    return { content: "You don't have permission to remove drivers from divisions.", ephemeral: true };
  }

  const targetId = ctx.options.driver as string | undefined;
  if (!targetId) {
    return { content: "driver is required.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", targetId)
    .maybeSingle();

  if (!driver) {
    return { content: "That user has no driver record.", ephemeral: true };
  }

  const { data: current } = await supabase
    .schema("pitboss")
    .from("division_members")
    .select("id, division_id")
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .eq("active", true)
    .maybeSingle();

  if (!current) {
    return { content: `<@${targetId}> isn't in a division.`, ephemeral: true };
  }

  const { data: division } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("division_code, discord_checkin_role_id")
    .eq("id", current.division_id)
    .maybeSingle();

  const { error } = await supabase
    .schema("pitboss")
    .from("division_members")
    .update({ active: false })
    .eq("id", current.id);

  if (error) {
    console.error("[division_remove] update failed:", error);
    return { content: `Something went wrong: ${error.message}`, ephemeral: true };
  }

  const notes: string[] = [];
  if (ctx.guildId && division?.discord_checkin_role_id) {
    const removed = await discordRequest(
      "DELETE",
      `/guilds/${ctx.guildId}/members/${targetId}/roles/${division.discord_checkin_role_id}`
    );
    if (!removed.ok) notes.push(`Couldn't remove the Discord role (${removed.status}).`);
  }

  return {
    content: [`<@${targetId}> removed from Division **${division?.division_code ?? "?"}**.`, ...notes].join("\n"),
    ephemeral: true,
  };
});

// ---------------------------------------------------------------------
// /division link — attach an existing channel/role, or change name/cap.
// Use this for divisions that already exist (e.g. WSC F2, which has no
// check-in channel yet) so check-in can start recognizing them.
// ---------------------------------------------------------------------
registerCommand("division_link", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }
  if (!(await isDivisionAdmin(ctx.discordUserId, leagueId))) {
    return { content: "You don't have permission to edit divisions.", ephemeral: true };
  }

  const code = cleanCode(ctx.options.code);
  if (!code) {
    return { content: "code is required (e.g. D1).", ephemeral: true };
  }

  const divisionResult = await findDivision(leagueId, code);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Couldn't find that division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const updates: Record<string, unknown> = {};
  const changed: string[] = [];

  const channel = ctx.options.checkin_channel as string | undefined;
  const role = ctx.options.role as string | undefined;
  const maxDrivers = ctx.options.max_drivers as number | undefined;
  const name = (ctx.options.name as string | undefined)?.trim();

  if (channel) {
    updates.discord_checkin_channel_id = channel;
    changed.push(`check-in channel <#${channel}>`);
  }
  if (role) {
    updates.discord_checkin_role_id = role;
    changed.push(`role <@&${role}>`);
  }
  if (maxDrivers != null) {
    updates.max_drivers = maxDrivers;
    changed.push(`max drivers ${maxDrivers}`);
  }
  if (name) {
    updates.division_name = name;
    changed.push(`name "${name}"`);
  }

  if (changed.length === 0) {
    return {
      content: "Nothing to change — pass at least one of checkin_channel, role, max_drivers or name.",
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .update(updates)
    .eq("id", division.id);

  if (error) {
    console.error("[division_link] update failed:", error);
    return { content: `Something went wrong: ${error.message}`, ephemeral: true };
  }

  return {
    content: `Division **${division.division_code}** updated: ${changed.join(", ")}.`,
    ephemeral: true,
  };
});

// ---------------------------------------------------------------------
// /division delete — removes the division row (and its memberships).
// Blocked by the database if the division already has rounds or
// check-ins attached, so history is never silently wiped.
// ---------------------------------------------------------------------
registerCommand("division_delete", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league server.", ephemeral: true };
  }
  if (!(await isDivisionAdmin(ctx.discordUserId, leagueId))) {
    return { content: "You don't have permission to delete divisions.", ephemeral: true };
  }

  const code = cleanCode(ctx.options.code);
  if (!code) {
    return { content: "code is required (e.g. D1).", ephemeral: true };
  }

  const divisionResult = await findDivision(leagueId, code);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Couldn't find that division.", ephemeral: true };
  }
  const division = divisionResult.division;
  const deleteDiscord = Boolean(ctx.options.delete_discord);
  const guildId = ctx.guildId;

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .schema("rise_os")
        .from("league_divisions")
        .delete()
        .eq("id", division.id);

      if (error) {
        console.error("[division_delete] delete failed:", error);
        if (error.code === "23503") {
          return {
            content: `Division **${division.division_code}** has rounds or check-ins attached, so it can't be deleted without losing that history.`,
          };
        }
        return { content: `Couldn't delete the division: ${error.message}` };
      }

      const notes: string[] = [];
      if (deleteDiscord && guildId) {
        if (division.discord_checkin_channel_id) {
          const r = await discordRequest("DELETE", `/channels/${division.discord_checkin_channel_id}`);
          if (!r.ok) notes.push(`Couldn't delete the check-in channel (${r.status}).`);
        }
        if (division.discord_category_id) {
          const r = await discordRequest("DELETE", `/channels/${division.discord_category_id}`);
          if (!r.ok) notes.push(`Couldn't delete the category (${r.status}).`);
        }
        if (division.discord_checkin_role_id) {
          const r = await discordRequest("DELETE", `/guilds/${guildId}/roles/${division.discord_checkin_role_id}`);
          if (!r.ok) notes.push(`Couldn't delete the role (${r.status}).`);
        }
      }

      return {
        content: [
          `Division **${division.division_code}** deleted.${deleteDiscord ? "" : " Its Discord role and channels were left in place."}`,
          ...notes,
        ].join("\n"),
      };
    },
  };
});
