const VIEW_CHANNEL = 1 << 10; // 1024
const SEND_MESSAGES = 1 << 11; // 2048
const READ_MESSAGE_HISTORY = 1 << 16; // 65536

const DISCORD_API_BASE = "https://discord.com/api/v10";

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
    { id: args.guildId, type: 0, deny: String(VIEW_CHANNEL) },
    {
      id: appId,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
    {
      id: args.stewardRoleId,
      type: 0,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
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
    `${DISCORD_API_BASE}/guilds/${args.guildId}/channels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `incident-${args.shortId}`,
        type: 0,
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
    `${DISCORD_API_BASE}/channels/${channel.id}/messages`,
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
  }

  return channel.id as string;
}

interface DiscordMessage {
  author: { username: string; bot?: boolean };
  content: string;
  timestamp: string;
}

interface DiscordMessageRaw extends DiscordMessage {
  id: string;
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

  const collected: DiscordMessageRaw[] = [];
  let before: string | undefined;

  for (let page = 0; page < 2; page++) {
    const url = new URL(`${DISCORD_API_BASE}/channels/${channelId}/messages`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bot ${token}` },
    });

    if (!res.ok) {
      console.error(
        "[tickets] transcript fetch failed:",
        res.status,
        await res.text()
      );
      break;
    }

    const batch: DiscordMessageRaw[] = await res.json();
    if (batch.length === 0) break;

    collected.push(...batch);
    before = batch[batch.length - 1].id;

    if (batch.length < 100) break;
  }

  if (collected.length === 0) {
    return null;
  }

  const ordered = collected.reverse();

  const lines = ordered.map((m) => {
    const time = new Date(m.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return `[${time}] ${m.author.username}: ${m.content || "(no text content)"}`;
  });

  return lines.join("\n");
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

  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
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

/**
 * Removes SEND_MESSAGES from the given users on a ticket channel
 * while leaving VIEW_CHANNEL/READ_MESSAGE_HISTORY intact — used on
 * /steward close so the reporter and accused can still read back
 * over the resolved ticket but can't keep posting in it.
 */
export async function lockTicketChannel(
  channelId: string,
  discordIds: string[]
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const results = await Promise.all(
    discordIds.map(async (id) => {
      const res = await fetch(
        `${DISCORD_API_BASE}/channels/${channelId}/permissions/${id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: 1,
            allow: String(VIEW_CHANNEL | READ_MESSAGE_HISTORY),
            deny: String(SEND_MESSAGES),
          }),
        }
      );
      if (!res.ok) {
        console.error(
          "[tickets] lock permission update failed for",
          id,
          res.status,
          await res.text()
        );
        return false;
      }
      return true;
    })
  );

  return results.every(Boolean);
}

export async function deleteTicketChannel(channelId: string): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
    method: "DELETE",
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) {
    console.error("[tickets] channel delete failed:", res.status, await res.text());
    return false;
  }
  return true;
}

export async function sendDirectMessage(
  discordUserId: string,
  content: string
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const dmRes = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });

  if (!dmRes.ok) {
    console.error("[tickets] DM channel open failed:", dmRes.status, await dmRes.text());
    return false;
  }

  const dmChannel = await dmRes.json();

  const msgRes = await fetch(`${DISCORD_API_BASE}/channels/${dmChannel.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!msgRes.ok) {
    console.error("[tickets] DM send failed:", msgRes.status, await msgRes.text());
    return false;
  }
  return true;
}

/**
 * Posts arbitrary text content as a file attachment to a channel —
 * used to archive full ticket transcripts to a league's configured
 * transcript channel, since a chat message is capped at ~2000 chars
 * but a file attachment isn't.
 */
export async function postTicketFile(
  channelId: string,
  filename: string,
  content: string,
  message?: string
): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] DISCORD_BOT_TOKEN not set");
    return false;
  }

  const form = new FormData();
  if (message) {
    form.append("payload_json", JSON.stringify({ content: message }));
  }
  form.append("files[0]", new Blob([content], { type: "text/plain" }), filename);

  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });

  if (!res.ok) {
    console.error("[tickets] postTicketFile failed:", res.status, await res.text());
    return false;
  }
  return true;
}
