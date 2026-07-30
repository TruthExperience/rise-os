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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  const appId = process.env.PITBOSS_DISCORD_APPLICATION_ID;
  if (!token || !appId) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN or PITBOSS_DISCORD_APPLICATION_ID not set");
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

interface AppealEvidenceItem {
  url: string;
  label?: string | null;
  party: string; // "reporter" | "accused" — kept as string since legacy
  // evidence_urls/accused_evidence_urls arrays don't carry a party tag
  // of their own; the caller assigns it based on which column it came
  // from before passing it in here.
}

interface CreateAppealTicketArgs {
  guildId: string;
  categoryId: string;
  stewardRoleId: string;
  appellantDiscordId: string;
  shortId: string; // short ID of the incident being appealed
  appealReason: string;
  originalVerdict?: string | null;
  originalPenalty?: string | null;
  originalPenaltyPoints?: number | null;
  evidence: AppealEvidenceItem[];
}

/**
 * Creates a private text channel for an appeal, visible only to the
 * appellant, the steward role, and the bot — not automatically the
 * other original party (reporter or accused, whichever didn't file),
 * since an appeal ticket shouldn't default to re-exposing the full
 * incident thread to someone not part of the appeal. Posts the
 * appeal details plus every piece of evidence gathered from the
 * original incident as the first message(s). Returns the new
 * channel ID, or null if channel creation failed (caller should
 * still record the appeal rather than block on this).
 */
export async function createAppealTicket(
  args: CreateA
