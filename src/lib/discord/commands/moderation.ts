import { registerCommand } from "./registry";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import { postTicketMessage } from "../tickets";

const OWNER_FLAGS = ["is_owner", "is_co_owner"] as const;

// Mirrors pitboss-guardian's ALERTS_CHANNEL_ID — same AARL pilot
// scoping (hardcoded, not pulled from league config) as the rest of
// the guardian system, so manual moderation actions show up in the
// same place automatic raid/nuke detections do.
const AARL_SECURITY_ALERTS_CHANNEL_ID = "1531851227611140196"; // #security-alerts

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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN?.trim();
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
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }
  const guildId = ctx.guildId;
  if (!guildId) {
    return { content: "This command must be used in a server.", ephemeral: true };
  }

  const denied = await requireOwner({ discordUserId: ctx.discordUserId, leagueId });
  if (denied) return { content: denied, ephemeral: true };

  const targetId = ctx.options.user as string;
  const reason = ctx.options.reason as string | undefined;
  const targetUsername = ctx.resolvedUsers[targetId]?.username ?? targetId;

  const result = await discordModerationCall(guildId, targetId, "kick", reason);
  if (!result.ok) {
    return { content: `Couldn't kick <@${targetId}>: ${result.error}`, ephemeral: true };
  }

  // Manual moderation doesn't go through respondToThreat, so nothing
  // posts to #security-alerts unless we do it here explicitly.
  await postTicketMessage(
    AARL_SECURITY_ALERTS_CHANNEL_ID,
    `👢 **Manual kick** — <@${targetId}> (${targetUsername}) kicked by <@${ctx.discordUserId}>.${reason ? ` Reason: ${reason}` : ""}`
  );

  return {
    content: `👢 <@${targetId}> (${targetUsername}) was kicked.${reason ? ` Reason: ${reason}` : ""}`,
    ephemeral: false,
  };
});

registerCommand("ban", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }
  const guildId = ctx.guildId;
  if (!guildId) {
    return { content: "This command must be used in a server.", ephemeral: true };
  }

  const denied = await requireOwner({ discordUserId: ctx.discordUserId, leagueId });
  if (denied) return { content: denied, ephemeral: true };

  const targetId = ctx.options.user as string;
  const reason = ctx.options.reason as string | undefined;
  const targetUsername = ctx.resolvedUsers[targetId]?.username ?? targetId;

  const result = await discordModerationCall(guildId, targetId, "ban", reason);
  if (!result.ok) {
    return { content: `Couldn't ban <@${targetId}>: ${result.error}`, ephemeral: true };
  }

  await postTicketMessage(
    AARL_SECURITY_ALERTS_CHANNEL_ID,
    `🔨 **Manual ban** — <@${targetId}> (${targetUsername}) banned by <@${ctx.discordUserId}>.${reason ? ` Reason: ${reason}` : ""}`
  );

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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN?.trim();

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
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const denied = await requireOwner({ discordUserId: ctx.discordUserId, leagueId });
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

      await postTicketMessage(
        AARL_SECURITY_ALERTS_CHANNEL_ID,
        `🔒 **Manual lockdown** triggered by <@${ctx.discordUserId}>. ${result.data.channelsLocked} channel(s) restricted, ${result.data.invitesDeleted} invite(s) removed.${reason ? ` Reason: ${reason}` : ""}`
      );

      return {
        content: `🔒 Server locked down. ${result.data.channelsLocked} channel(s) restricted, ${result.data.invitesDeleted} invite(s) removed.${reason ? ` Reason: ${reason}` : ""}`,
      };
    },
  };
});

registerCommand("endlockdown", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const denied = await requireOwner({ discordUserId: ctx.discordUserId, leagueId });
  if (denied) return { content: denied, ephemeral: true };

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const result = await guardianCall("/endlockdown");

      if (!result.ok) {
        return { content: `Couldn't lift the lockdown: ${result.error}` };
      }

      await postTicketMessage(
        AARL_SECURITY_ALERTS_CHANNEL_ID,
        `🔓 **Lockdown lifted** by <@${ctx.discordUserId}>. ${result.data.channelsRestored} channel(s) restored${result.data.channelsFailed ? `, ${result.data.channelsFailed} failed` : ""}. ${result.data.note}`
      );

      return {
        content: `🔓 Lockdown lifted. ${result.data.channelsRestored} channel(s) restored${result.data.channelsFailed ? `, ${result.data.channelsFailed} failed` : ""}. ${result.data.note}`,
      };
    },
  };
});
