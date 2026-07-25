import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import {
  createIncidentTicket,
  buildTicketTranscript,
  lockTicketChannel,
  deleteTicketChannel,
  postTicketMessage,
} from "../tickets";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Same posture as roster.ts's EDITOR_FLAGS, but for moderation
// actions on tickets — team principals can edit rosters, but closing
// or deleting an incident ticket is a stewarding action.
const STEWARD_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_head_steward",
  "is_steward",
] as const;

// Same driver-lookup/auto-create pattern as roster.ts's getTeamId
// section — a reporter (or accused party) may not have a `drivers`
// row yet if they've never touched roster/cert commands before.
async function getOrCreateDriverId(
  discordId: string,
  username?: string
): Promise<string | null> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .schema("pitboss")
    .from("drivers")
    .insert({
      discord_id: discordId,
      discord_username: username ?? discordId,
    })
    .select("id")
    .single();

  if (error || !created) {
    console.error("[steward] driver creation failed:", error);
    return null;
  }
  return created.id;
}

registerCommand("steward_report", async (ctx) => {
  const incidentType = ctx.options.type as string;
  const description = ctx.options.description as string;
  const accusedDiscordId = ctx.options.accused as string | undefined;
  const lap = ctx.options.lap as number | undefined;
  const round = ctx.options.round as number | undefined;
  const evidenceUrl = ctx.options.evidence as string | undefined;

  const reporterId = await getOrCreateDriverId(ctx.discordUserId);
  if (!reporterId) {
    return {
      content: "Couldn't set up your driver record — try again in a moment.",
      ephemeral: true,
    };
  }

  let accusedDriverId: string | null = null;
  let accusedUsername: string | null = null;
  if (accusedDiscordId) {
    accusedUsername = ctx.resolvedUsers[accusedDiscordId]?.username ?? null;
    accusedDriverId = await getOrCreateDriverId(
      accusedDiscordId,
      accusedUsername ?? undefined
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .insert({
      league_id: ctx.leagueId,
      reported_by: reporterId,
      accused_driver_id: accusedDriverId,
      accused_discord_username: accusedUsername,
      incident_type: incidentType,
      description,
      lap: lap ?? null,
      round: round ?? null,
      evidence_urls: evidenceUrl ? [evidenceUrl] : [],
      status: "open",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[steward_report] insert failed:", error);
    return {
      content: `Something went wrong filing that report: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  const shortId = data.id.slice(0, 8);

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_ticket_category_id, discord_steward_role_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  if (
    !leagueConfig?.discord_ticket_category_id ||
    !leagueConfig?.discord_steward_role_id
  ) {
    return {
      content: `Incident **${shortId}** filed (${incidentType}). No ticket category is configured for this league yet, so nothing was posted to Discord — ask an admin to set one up. Check status with \`/steward status\`.`,
      ephemeral: true,
    };
  }

  const channelId = await createIncidentTicket({
    guildId: ctx.guildId,
    categoryId: leagueConfig.discord_ticket_category_id,
    stewardRoleId: leagueConfig.discord_steward_role_id,
    reporterDiscordId: ctx.discordUserId,
    accusedDiscordId: accusedDiscordId ?? null,
    shortId,
    incidentType,
    description,
    lap,
    round,
    evidenceUrl,
  });

  if (!channelId) {
    return {
      content: `Incident **${shortId}** filed (${incidentType}), but I couldn't open a ticket channel for it. Stewards can still see it via \`/steward status\`.`,
      ephemeral: true,
    };
  }

  await supabase
    .schema("pitboss")
    .from("incidents")
    .update({ ticket_channel_id: channelId })
    .eq("id", data.id);

  return {
    content: `Incident **${shortId}** filed — see <#${channelId}> for the ticket.`,
    ephemeral: true,
  };
});

registerCommand("steward_status", async (ctx) => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select("id, incident_type, status, created_at, accused_discord_username")
    .eq("league_id", ctx.leagueId)
    .in("status", ["open", "under_review", "appealed"])
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !data) {
    console.error("[steward_status] query failed:", error);
    return {
      content: `Couldn't load incident status: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  if (data.length === 0) {
    return { content: "No open incidents for this league.", ephemeral: true };
  }

  const lines = data.map((inc) => {
    const shortId = inc.id.slice(0, 8);
    const against = inc.accused_discord_username
      ? ` vs ${inc.accused_discord_username}`
      : "";
    return `**${shortId}** — ${inc.incident_type}${against} — *${inc.status}*`;
  });

  return { content: lines.join("\n"), ephemeral: true };
});

async function requireSteward(ctx: {
  discordUserId: string;
  leagueId: string;
}): Promise<string | null> {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...STEWARD_FLAGS])) {
    return "Only stewards, commissioners, or owners can do that.";
  }
  return null;
}

async function findIncidentByChannel(leagueId: string, channelId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select(
      "id, status, ticket_closed_at, reported_by, accused_driver_id, drivers!incidents_reported_by_fkey(discord_id)"
    )
    .eq("league_id", leagueId)
    .eq("ticket_channel_id", channelId)
    .maybeSingle();
  return data;
}

registerCommand("steward_close", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }
  if (incident.ticket_closed_at) {
    return { content: "This ticket is already closed.", ephemeral: true };
  }

  const transcript = await buildTicketTranscript(ctx.channelId);

  const supabase = createAdminClient();
  const { error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      ticket_transcript: transcript,
      ticket_closed_at: new Date().toISOString(),
      status: incident.status === "open" || incident.status === "under_review"
        ? "resolved"
        : incident.status,
    })
    .eq("id", incident.id);

  if (error) {
    console.error("[steward_close] update failed:", error);
    return {
      content: `Couldn't save the close: ${error.message}`,
      ephemeral: true,
    };
  }

  const discordIds: string[] = [];
  const reporterDiscordId = (incident as any).drivers?.discord_id as
    | string
    | undefined;
  if (reporterDiscordId) discordIds.push(reporterDiscordId);

  if (incident.accused_driver_id) {
    const { data: accusedDriver } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("discord_id")
      .eq("id", incident.accused_driver_id)
      .maybeSingle();
    if (accusedDriver?.discord_id) discordIds.push(accusedDriver.discord_id);
  }

  if (discordIds.length > 0) {
    await lockTicketChannel(ctx.channelId, discordIds);
  }
  await postTicketMessage(
    ctx.channelId,
    "🔒 This ticket has been closed by a steward. A transcript has been saved. Use `/steward delete` to remove this channel once you're done reviewing it."
  );

  return {
    content: "Ticket closed and transcript saved.",
    ephemeral: true,
  };
});

registerCommand("steward_transcript", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const transcript =
    incident.ticket_transcript ?? (await buildTicketTranscript(ctx.channelId));

  if (!transcript) {
    return { content: "Couldn't build a transcript for this ticket.", ephemeral: true };
  }

  // Discord messages cap at ~2000 chars — truncate for the reply and
  // note the full version is on file if it's longer than that.
  const preview =
    transcript.length > 1800
      ? `${transcript.slice(0, 1800)}\n… (truncated — full transcript is saved on the incident record)`
      : transcript;

  return {
    content: `\`\`\`\n${preview}\n\`\`\``,
    ephemeral: true,
  };
});

registerCommand("steward_delete", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }
  if (!incident.ticket_closed_at) {
    return {
      content: "Close the ticket first with `/steward close` before deleting it — that saves the transcript.",
      ephemeral: true,
    };
  }

  const ok = await deleteTicketChannel(ctx.channelId);
  if (!ok) {
    return { content: "Couldn't delete the channel — check my permissions.", ephemeral: true };
  }

  // The channel is gone by the time this reply renders, but the
  // interaction response still needs non-empty content.
  return { content: "🗑️ Ticket deleted.", ephemeral: true };
});
