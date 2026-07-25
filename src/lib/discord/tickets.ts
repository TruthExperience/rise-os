const VIEW_CHANNEL = 1 << 10; // 1024
const SEND_MESSAGES = 1 << 11; // 2048
const READ_MESSAGE_HISTORY = 1 << 16; // 65536

interface CreateIncidentTicketArgs {
  guildId: string;
  categoryId: string;
  stewardRoleId: string;
  reporterDiscordId: string;
  accusedDiscordId?: string | null;
  shortId: string;
  incidentType: string;
  description: string;
  lap?: number | null;
  round?: number | null;
  evidenceUrl?: string | null;
}

/**
 * Creates a private text channel under the league's configured
 * ticket category, visible only to the reporter, the accused (if
 * named), the steward role, and the bot itself. Posts the incident
 * details as the first message. Returns the new channel ID, or null
 * if channel creation failed (caller should fall back to an
 * ephemeral-only response rather than blocking the report).
 */
export async function createIncidentTicket(
  args: CreateIncidentTicketArgs
): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  if (!token || !appId) {
    console.error("[tickets] DISCORD_BOT_TOKEN or DISCORD_APP_ID not set");
    return null;
  }

  const permissionOverwrites = [
    // @everyone: deny view
    { id: args.guildId, type: 0, deny: String(VIEW_CHANNEL) },
    // the bot itself: needs to view/post/read history to manage the ticket
    {
      id: appId,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
    // steward role: full access to review the ticket
    {
      id: args.stewardRoleId,
      type: 0,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
    // reporter: can view and respond in their own ticket
    {
      id: args.reporterDiscordId,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
    ...(args.accusedDiscordId
      ? [
          {
            id: args.accusedDiscordId,
            type: 1,
            allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
          },
        ]
      : []),
  ];

  const channelRes = await fetch(
    `https://discord.com/api/v10/guilds/${args.guildId}/channels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `incident-${args.shortId}`,
        type: 0, // GUILD_TEXT
        parent_id: args.categoryId,
        permission_overwrites: permissionOverwrites,
      }),
    }
  );

  if (!channelRes.ok) {
    console.error(
      "[tickets] channel creation failed:",
      channelRes.status,
      await channelRes.text()
    );
    return null;
  }

  const channel = await channelRes.json();

  const lines = [
    `**Incident ${args.shortId}** — ${args.incidentType}`,
    `Reported by <@${args.reporterDiscordId}>${
      args.accusedDiscordId ? ` against <@${args.accusedDiscordId}>` : ""
    }`,
    args.round ? `Round: ${args.round}` : null,
    args.lap ? `Lap: ${args.lap}` : null,
    `\n${args.description}`,
    args.evidenceUrl ? `\nEvidence: ${args.evidenceUrl}` : null,
    `\n<@&${args.stewardRoleId}> — please review.`,
  ].filter(Boolean);

  const msgRes = await fetch(
    `https://discord.com/api/v10/channels/${channel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: lines.join("\n") }),
    }
  );

  if (!msgRes.ok) {
    console.error(
      "[tickets] initial message post failed:",
      msgRes.status,
      await msgRes.text()
    );
    // Channel exists even if the message failed — still return it.
  }

  return channel.id as string;
}

interface DiscordMessage {
  author: { username: string; bot?: boolean };
  content: string;
  timestamp: string;
}

/**
 * Pulls up to 200 messages from a ticket channel (Discord returns at
 * most 100 per call, so this pages once) and formats them as a plain
 * text transcript, oldest first. Good enough for typical ticket
 * threads; very long tickets will be truncated at 200 messages.
 */
export async function buildTicketTranscript(
  channelId: string
): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return null;
  }

  const all: DiscordMessage[] = [];
  let before: string | undefined;

  for (let page = 0; page < 2; page++) {
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
    });

    if (!res.ok) {
      console.error("[tickets] transcript fetch failed:", res.status, await res.text());
      return all.length > 0 ? formatTranscript(all) : null;
    }

    const batch: any[] = await res.json();
    if (batch.length === 0) break;

    all.push(
      ...batch.map((m) => ({
        author: { username: m.author?.username ?? "unknown", bot: m.author?.bot },
        content: m.content ?? "",
        timestamp: m.timestamp,
      }))
    );

    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }

  return formatTranscript(all);
}

function formatTranscript(messages: DiscordMessage[]): string {
  return messages
    .slice()
    .reverse() // Discord returns newest-first; transcripts read oldest-first
    .map((m) => {
      const time = new Date(m.timestamp).toISOString();
      const who = m.author.bot ? `${m.author.username} [bot]` : m.author.username;
      return `[${time}] ${who}: ${m.content}`;
    })
    .join("\n");
}

/**
 * Locks a ticket channel by revoking SEND_MESSAGES from the reporter
 * and accused (they keep VIEW/READ_MESSAGE_HISTORY so the record
 * stays visible), leaving the steward role and bot with full access.
 */
export async function lockTicketChannel(
  channelId: string,
  discordIdsToLock: string[]
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  let ok = true;
  for (const id of discordIdsToLock) {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/permissions/${id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: 1, // member
          allow: String(VIEW_CHANNEL | READ_MESSAGE_HISTORY),
          deny: String(SEND_MESSAGES),
        }),
      }
    );
    if (!res.ok) {
      console.error("[tickets] lock overwrite failed for", id, res.status, await res.text());
      ok = false;
    }
  }
  return ok;
}

export async function postTicketMessage(
  channelId: string,
  content: string
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    console.error("[tickets] postTicketMessage failed:", res.status, await res.text());
    return false;
  }
  return true;
}

export async function deleteTicketChannel(channelId: string): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    method: "DELETE",
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) {
    console.error("[tickets] channel delete failed:", res.status, await res.text());
    return false;
  }
  return true;
}

/**
 * Sends a direct message to a Discord user. Requires opening (or
 * reusing) a DM channel first — Discord bots can't post to a user
 * directly without one. Returns false if the user has DMs disabled
 * for this server/bot, which is a normal, expected outcome (not a
 * bug) — callers should treat it as "couldn't notify them" and
 * continue, not as a failure to surface loudly.
 */
export async function sendDirectMessage(
  discordUserId: string,
  content: string
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const dmChannelRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });

  if (!dmChannelRes.ok) {
    console.error(
      "[tickets] DM channel creation failed:",
      dmChannelRes.status,
      await dmChannelRes.text()
    );
    return false;
  }

  const dmChannel = await dmChannelRes.json();

  const msgRes = await fetch(
    `https://discord.com/api/v10/channels/${dmChannel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    }
  );

  if (!msgRes.ok) {
    console.error(
      "[tickets] DM send failed (user may have DMs disabled):",
      msgRes.status,
      await msgRes.text()
    );
    return false;
  }

  return true;
}
