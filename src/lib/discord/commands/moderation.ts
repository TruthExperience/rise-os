import { registerCommand } from "./registry";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

const OWNER_FLAGS = ["is_owner", "is_co_owner"] as const;

async function requireOwner(ctx: {
  discordUserId: string;
  leagueId: string;
}): Promise<string | null> {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...OWNER_FLAGS])) {
    return "Only the owner or co-owners can do that.";
  }
  return null;
}

async function discordModerationCall(
  guildId: string,
  targetDiscordId: string,
  action: "kick" | "ban",
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const url =
    action === "kick"
      ? `https://discord.com/api/v10/guilds/${guildId}/members/${targetDiscordId}`
      : `https://discord.com/api/v10/guilds/${guildId}/bans/${targetDiscordId}`;

  const res = await fetch(url, {
    method: action === "kick" ? "DELETE" : "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(reason ? { "X-Audit-Log-Reason": reason } : {}),
    },
    ...(action === "ban" ? { body: JSON.stringify({ delete_message_seconds: 0 }) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[moderation] ${action} failed for ${targetDiscordId}:`, res.status, text);
    return { ok: false, error: `Discord API error (${res.status})` };
  }
  return { ok: true };
}

registerCommand("kick", async (ctx) => {
  const denied = await requireOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const targetId = ctx.options.user as string;
  const reason = ctx.options.reason as string | undefined;
  const targetUsername = ctx.resolvedUsers[targetId]?.username ?? targetId;

  const result = await discordModerationCall(ctx.guildId, targetId, "kick", reason);
  if (!result.ok) {
    return { content: `Couldn't kick <@${targetId}>: ${result.error}`, ephemeral: true };
  }

  return {
    content: `👢 <@${targetId}> (${targetUsername}) was kicked.${reason ? ` Reason: ${reason}` : ""}`,
    ephemeral: false,
  };
});

registerCommand("ban", async (ctx) => {
  const denied = await requireOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const targetId = ctx.options.user as string;
  const reason = ctx.options.reason as string | undefined;
  const targetUsername = ctx.resolvedUsers[targetId]?.username ?? targetId;

  const result = await discordModerationCall(ctx.guildId, targetId, "ban", reason);
  if (!result.ok) {
    return { content: `Couldn't ban <@${targetId}>: ${result.error}`, ephemeral: true };
  }

  return {
    content: `🔨 <@${targetId}> (${targetUsername}) was banned.${reason ? ` Reason: ${reason}` : ""}`,
    ephemeral: false,
  };
});

async function guardianCall(
  path: "/lockdown" | "/endlockdown",
  body?: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; data?: any }> {
  const workerUrl = process.env.GUARDIAN_WORKER_URL?.trim();
  const token = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!workerUrl) {
    return { ok: false, error: "GUARDIAN_WORKER_URL is not configured" };
  }

  const res = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: {
      "X-Guardian-Key": token ?? "",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const error = data?.error ?? `pitboss-guardian error (${res.status})`;
    console.error(`[moderation] ${path} failed:`, res.status, data);
    return { ok: false, error };
  }

  return { ok: true, data };
}

registerCommand("lockdown", async (ctx) => {
  const denied = await requireOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const reason = ctx.options.reason as string | undefined;

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const result = await guardianCall("/lockdown", {
        reason,
        triggeredBy: ctx.discordUserId,
      });

      if (!result.ok) {
        return { content: `Couldn't lock down the server: ${result.error}` };
      }

      return {
        content: `🔒 Server locked down. ${result.data.channelsLocked} channel(s) restricted, ${result.data.invitesDeleted} invite(s) removed.${reason ? ` Reason: ${reason}` : ""}`,
      };
    },
  };
});

registerCommand("endlockdown", async (ctx) => {
  const denied = await requireOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const result = await guardianCall("/endlockdown");

      if (!result.ok) {
        return { content: `Couldn't lift the lockdown: ${result.error}` };
      }

      return {
        content: `🔓 Lockdown lifted. ${result.data.channelsRestored} channel(s) restored${result.data.channelsFailed ? `, ${result.data.channelsFailed} failed` : ""}. ${result.data.note}`,
      };
    },
  };
});
