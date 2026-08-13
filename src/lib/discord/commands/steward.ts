// steward.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import {
  createIncidentTicket,
  buildTicketTranscript,
  lockTicketChannel,
  deleteTicketChannel,
  postTicketMessage,
  postTicketFile,
  sendDirectMessage,
} from "../tickets";
import { hasDiscordStewardAccess } from "../permissions";

function resolveAppBaseUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) {
    const withScheme = /^https?:\/\//.test(explicit)
      ? explicit
      : `https://${explicit}`;
    return withScheme.replace(/\/$/, "");
  }

  const prodUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodUrl) return `https://${prodUrl}`;

  const deploymentUrl = process.env.VERCEL_URL;
  if (deploymentUrl) return `https://${deploymentUrl}`;

  return null;
}

// Sequential per-league ticket number (e.g. "0007") once assigned by
// rise_os.increment_ticket_number; falls back to the old UUID-slice
// display for incidents filed before the ticket_number migration.
// Exported so appeal.ts can render the same label for a given incident.
export function getTicketLabel(incident: {
  id: string;
  ticket_number: number | null;
}): string {
  if (incident.ticket_number !== null && incident.ticket_number !== undefined) {
    return String(incident.ticket_number).padStart(4, "0");
  }
  return incident.id.slice(0, 8);
}

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

  // Claim the next sequential ticket number for this league atomically
  // before inserting, so the incident row is created with its final
  // number already set rather than backfilled after the fact.
  const { data: ticketNumber, error: ticketNumberError } = await supabase
    .schema("rise_os")
    .rpc("increment_ticket_number", { p_league_id: ctx.leagueId });

  if (ticketNumberError || ticketNumber === null || ticketNumber === undefined) {
    console.error("[steward_report] ticket number claim failed:", ticketNumberError);
    return {
      content: "Couldn't assign a ticket number — try again in a moment.",
      ephemeral: true,
    };
  }

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
      ticket_number: ticketNumber,
    })
    .select("id, ticket_number")
    .single();

  if (error || !data) {
    console.error("[steward_report] insert failed:", error);
    return {
      content: `Something went wrong filing that report: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  const ticketLabel = getTicketLabel(data);

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_ticket_category_id, discord_steward_role_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  let channelId: string | null = null;
  let ticketNote: string;

  if (
    !leagueConfig?.discord_ticket_category_id ||
    !leagueConfig?.discord_steward_role_id
  ) {
    ticketNote = `Incident **${ticketLabel}** filed (${incidentType}). No ticket category is configured for this league yet, so nothing was posted to Discord — ask an admin to set one up. Check status with \`/steward status\`.`;
  } else {
    channelId = await createIncidentTicket({
      guildId: ctx.guildId,
      categoryId: leagueConfig.discord_ticket_category_id,
      stewardRoleId: leagueConfig.discord_steward_role_id,
      reporterDiscordId: ctx.discordUserId,
      accusedDiscordId: accusedDiscordId ?? null,
      shortId: ticketLabel,
      incidentType,
      description,
      lap,
      round,
      evidenceUrl,
    });

    if (channelId) {
      await supabase
        .schema("pitboss")
        .from("incidents")
        .update({ ticket_channel_id: channelId })
        .eq("id", data.id);
      ticketNote = `Incident **${ticketLabel}** filed — see <#${channelId}> for the ticket.`;
    } else {
      ticketNote = `Incident **${ticketLabel}** filed (${incidentType}), but I couldn't open a ticket channel for it. Stewards can still see it via \`/steward status\`.`;
    }
  }

  if (accusedDiscordId) {
    const dmLines = [
      `You've been named in an incident report — **${ticketLabel}** (${incidentType}) — filed against you.`,
      `\n${description}`,
      evidenceUrl ? `\nEvidence submitted against you: ${evidenceUrl}` : null,
      channelId
        ? `\nRespond with your side in <#${channelId}> using \`/steward respond\` — you can include your own POV link.`
        : `\nA steward will follow up with a ticket channel shortly. Once it's open, use \`/steward respond\` there to give your side, including your own POV link if you have one.`,
    ].filter(Boolean);
    await sendDirectMessage(accusedDiscordId, dmLines.join("\n"));
  }

  return { content: ticketNote, ephemeral: true };
});

registerCommand("steward_status", async (ctx) => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select("id, incident_type, status, created_at, accused_discord_username, ticket_number")
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
    const label = getTicketLabel(inc);
    const against = inc.accused_discord_username
      ? ` vs ${inc.accused_discord_username}`
      : "";
    return `**${label}** — ${inc.incident_type}${against} — *${inc.status}*`;
  });

  return { content: lines.join("\n"), ephemeral: true };
});

async function requireSteward(ctx: {
  guildId: string;
  leagueId: string;
  memberRoles: string[];
  memberPermissions: string;
}): Promise
