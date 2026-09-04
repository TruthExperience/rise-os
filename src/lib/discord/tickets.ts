// tickets.ts
const VIEW_CHANNEL = 1 << 10; // 1024
const SEND_MESSAGES = 1 << 11; // 2048
const READ_MESSAGE_HISTORY = 1 << 16; // 65536

interface CreateIncidentTicketArgs {
  guildId: string;
  categoryId: string;
  stewardRoleId: string;
  reporterDiscordId: string;
  accusedDiscordId?: string | null;
  ticketLabel: string;
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
        name: `incident-${args.ticketLabel}`,
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
    `**Incident ${args.ticketLabel}** — ${args.incidentType}`,
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
  ticketLabel: string; // ticket label of the incident being appealed
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
  args: CreateAppealTicketArgs
): Promise<string | null> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  const appId = process.env.PITBOSS_DISCORD_APPLICATION_ID;
  if (!token || !appId) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN or PITBOSS_DISCORD_APPLICATION_ID not set");
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
      id: args.appellantDiscordId,
      type: 1,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
    },
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
        name: `appeal-${args.ticketLabel}`,
        type: 0, // GUILD_TEXT
        parent_id: args.categoryId,
        permission_overwrites: permissionOverwrites,
      }),
    }
  );

  if (!channelRes.ok) {
    console.error(
      "[tickets] appeal channel creation failed:",
      channelRes.status,
      await channelRes.text()
    );
    return null;
  }

  const channel = await channelRes.json();

  const headerLines = [
    `**Appeal — Incident ${args.ticketLabel}**`,
    `Filed by <@${args.appellantDiscordId}>`,
    `\n${args.appealReason}`,
    `\nOriginal verdict: ${args.originalVerdict ?? "—"}`,
    `Original penalty: ${args.originalPenalty ?? "—"}${
      args.originalPenaltyPoints ? ` (${args.originalPenaltyPoints} pts)` : ""
    }`,
    `\n<@&${args.stewardRoleId}> — use \`/appeal review\` to rule on this.`,
  ].filter(Boolean);

  const msgRes = await fetch(
    `https://discord.com/api/v10/channels/${channel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: headerLines.join("\n") }),
    }
  );

  if (!msgRes.ok) {
    console.error(
      "[tickets] appeal header message post failed:",
      msgRes.status,
      await msgRes.text()
    );
  }

  // Evidence posted as a separate message so a long list doesn't risk
  // pushing the header (and the steward-role mention) past Discord's
  // 2000-char limit and getting silently truncated together.
  if (args.evidence.length > 0) {
    const evidenceLines = [
      "**Evidence from the original incident:**",
      ...args.evidence.map(
        (e) => `- [${e.party}] ${e.label ? `${e.label}: ` : ""}${e.url}`
      ),
    ];
    const evidenceRes = await fetch(
      `https://discord.com/api/v10/channels/${channel.id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: evidenceLines.join("\n") }),
      }
    );
    if (!evidenceRes.ok) {
      console.error(
        "[tickets] appeal evidence message post failed:",
        evidenceRes.status,
        await evidenceRes.text()
      );
    }
  } else {
    await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: "_No evidence was attached to the original incident._",
      }),
    });
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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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

/**
 * Grants a user VIEW/SEND/READ_MESSAGE_HISTORY on a ticket channel via
 * a permission overwrite. Used for /steward adduser to bring in a
 * witness or other party after the ticket was already created.
 */
export async function addUserToTicketChannel(
  channelId: string,
  discordUserId: string
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
    return false;
  }

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/permissions/${discordUserId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: 1, // member
        allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY),
        deny: "0",
      }),
    }
  );

  if (!res.ok) {
    console.error(
      "[tickets] addUserToTicketChannel failed:",
      res.status,
      await res.text()
    );
    return false;
  }
  return true;
}

/**
 * Removes a user's permission overwrite from a ticket channel
 * entirely (rather than just denying SEND_MESSAGES like
 * lockTicketChannel does), so they lose VIEW_CHANNEL too and the
 * channel disappears from their list. Used for /steward removeuser.
 */
export async function removeUserFromTicketChannel(
  channelId: string,
  discordUserId: string
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
    return false;
  }

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/permissions/${discordUserId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bot ${token}` },
    }
  );

  if (!res.ok) {
    console.error(
      "[tickets] removeUserFromTicketChannel failed:",
      res.status,
      await res.text()
    );
    return false;
  }
  return true;
}

export async function postTicketMessage(
  channelId: string,
  content: string
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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

/**
 * Posts a message with a file attachment to a channel — used for
 * archiving transcripts, which can easily exceed Discord's ~2000 char
 * message content limit. Requires multipart/form-data rather than a
 * plain JSON body: a `payload_json` part carries the message content,
 * and a `files[0]` part carries the file bytes. `fetch` sets the
 * multipart boundary automatically from the FormData instance — do
 * NOT set a Content-Type header manually here, or the boundary will
 * be missing and Discord will reject the request.
 */
export async function postTicketFile(
  channelId: string,
  filename: string,
  fileContent: string,
  messageContent?: string
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
    return false;
  }

  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: messageContent ?? "" })
  );
  form.append("files[0]", new Blob([fileContent], { type: "text/plain" }), filename);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
    },
    body: form,
  });

  if (!res.ok) {
    console.error("[tickets] postTicketFile failed:", res.status, await res.text());
    return false;
  }
  return true;
}

export async function deleteTicketChannel(channelId: string): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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

/**
 * DMs a removed ticket opener asking whether they want to appeal the
 * verdict on the incident they were just removed from, with Yes/No
 * buttons. Fired from /steward removeuser in steward.ts when
 * force-removing a ticket opener from an already-resolved/dismissed
 * incident.
 *
 * Deliberately buttons, not a free-text reply: parsing "yes" typed
 * into a DM would need the bot to hold a persistent Gateway
 * connection with the MESSAGE_CONTENT privileged intent listening to
 * DM channels. Nothing in this webhook/interaction architecture does
 * that today — pitboss-guardian's Gateway connection is guild-scoped
 * anti-raid/anti-nuke, not DM message listening. Buttons come back as
 * ordinary MESSAGE_COMPONENT interactions through the same webhook
 * every slash command already uses.
 *
 * custom_id shape: "appeal_prompt:yes:<incidentId>" or
 * "appeal_prompt:no:<incidentId>" — handled by
 * handleAppealPromptComponent in appeal.ts. The top-level interaction
 * handler needs to route MESSAGE_COMPONENT interactions with a
 * custom_id starting with "appeal_prompt:" there; see that function's
 * doc comment for the exact contract.
 */
export async function sendAppealPromptDM(
  discordUserId: string,
  incidentId: string,
  ticketLabel: string
): Promise<boolean> {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[tickets] PITBOSS_DISCORD_BOT_TOKEN not set");
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
      "[tickets] appeal-prompt DM channel creation failed:",
      dmChannelRes.status,
      await dmChannelRes.text()
    );
    return false;
  }

  const dmChannel = await dmChannelRes.json();

  const ACTION_ROW = 1;
  const BUTTON = 2;
  const PRIMARY_STYLE = 1;
  const SECONDARY_STYLE = 2;

  const msgRes = await fetch(
    `https://discord.com/api/v10/channels/${dmChannel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: `You were removed from the ticket for incident **${ticketLabel}**. Do you want to appeal the verdict?`,
        components: [
          {
            type: ACTION_ROW,
            components: [
              {
                type: BUTTON,
                style: PRIMARY_STYLE,
                label: "Yes, file an appeal",
                custom_id: `appeal_prompt:yes:${incidentId}`,
              },
              {
                type: BUTTON,
                style: SECONDARY_STYLE,
                label: "No",
                custom_id: `appeal_prompt:no:${incidentId}`,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!msgRes.ok) {
    console.error(
      "[tickets] appeal-prompt DM send failed (user may have DMs disabled):",
      msgRes.status,
      await msgRes.text()
    );
    return false;
  }

  return true;
}
