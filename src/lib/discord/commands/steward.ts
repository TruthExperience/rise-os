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
  addUserToTicketChannel,
  removeUserFromTicketChannel,
  sendAppealPromptDM,
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

// accused, lap, round, and evidence used to be optional — now
// mandatory on /steward report so stewards always have a
// fully-formed report to work from instead of chasing missing context
// after the fact. Validated defensively below in addition to marking
// them required on the slash command schema itself (outside these
// files — wherever /steward report's options are registered with
// Discord), since ctx.options isn't guaranteed to match the schema at
// runtime.
registerCommand("steward_report", async (ctx) => {
  const incidentType = ctx.options.type as string;
  const description = ctx.options.description as string;
  const accusedDiscordId = ctx.options.accused as string | undefined;
  const lap = ctx.options.lap as number | undefined;
  const round = ctx.options.round as number | undefined;
  const evidenceUrl = ctx.options.evidence as string | undefined;

  if (!accusedDiscordId) {
    return {
      content: "`accused` is required — name the driver you're filing against.",
      ephemeral: true,
    };
  }
  if (round === undefined || round === null) {
    return { content: "`round` is required.", ephemeral: true };
  }
  if (lap === undefined || lap === null) {
    return { content: "`lap` is required.", ephemeral: true };
  }
  if (!evidenceUrl) {
    return {
      content: "`evidence` is required — stewards need a POV link to review this.",
      ephemeral: true,
    };
  }

  const reporterId = await getOrCreateDriverId(ctx.discordUserId);
  if (!reporterId) {
    return {
      content: "Couldn't set up your driver record — try again in a moment.",
      ephemeral: true,
    };
  }

  const accusedUsername = ctx.resolvedUsers[accusedDiscordId]?.username ?? null;
  const accusedDriverId = await getOrCreateDriverId(
    accusedDiscordId,
    accusedUsername ?? undefined
  );

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
      lap,
      round,
      evidence_urls: [evidenceUrl],
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
      accusedDiscordId,
      ticketLabel: ticketLabel,
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

  const dmLines = [
    `You've been named in an incident report — **${ticketLabel}** (${incidentType}) — filed against you.`,
    `\n${description}`,
    `\nEvidence submitted against you: ${evidenceUrl}`,
    channelId
      ? `\nRespond with your side in <#${channelId}> using \`/steward respond\` — you can include your own POV link.`
      : `\nA steward will follow up with a ticket channel shortly. Once it's open, use \`/steward respond\` there to give your side, including your own POV link if you have one.`,
  ].filter(Boolean);
  await sendDirectMessage(accusedDiscordId, dmLines.join("\n"));

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
}): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_steward_role_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  if (!hasDiscordStewardAccess(ctx, leagueConfig?.discord_steward_role_id ?? null)) {
    return "Only stewards, commissioners, or owners can do that.";
  }
  return null;
}

// Head-steward gate for /steward assign — deliberately checked against
// pitboss.driver_leagues.is_head_steward rather than a Discord role, so
// this stays a single source of truth with the web app's permission
// checks (getAuthedDriver / driver_leagues) instead of drifting from a
// second, Discord-only concept of "head steward".
async function requireHeadSteward(ctx: {
  leagueId: string;
  discordUserId: string;
}): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();

  if (!driver) return "Only the head steward can do that.";

  const { data: role } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_head_steward")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (!role?.is_head_steward) {
    return "Only the head steward can do that.";
  }
  return null;
}

async function findIncidentByChannel(leagueId: string, channelId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select(
      "id, status, ticket_closed_at, ticket_transcript, reported_by, accused_driver_id, ticket_number, assigned_steward_id, assigned_by, help_requested, drivers!incidents_reported_by_fkey(discord_id), assigned_steward:drivers!incidents_assigned_steward_id_fkey(discord_id)"
    )
    .eq("league_id", leagueId)
    .eq("ticket_channel_id", channelId)
    .maybeSingle();
  return data;
}

const EVIDENCE_SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 3;

type EvidenceItem = {
  url: string;
  label: string | null;
  source: "upload" | "link";
};

async function getIncidentEvidence(
  supabase: ReturnType<typeof createAdminClient>,
  incidentId: string,
  legacyReporterUrls: string[],
  legacyAccusedUrls: string[]
): Promise<{ reporter: EvidenceItem[]; accused: EvidenceItem[] }> {
  const { data: rows, error } = await supabase
    .schema("pitboss")
    .from("incident_evidence")
    .select("party, source, url, label")
    .eq("incident_id", incidentId);

  if (error) {
    console.error("[steward_analyse] incident_evidence query failed:", error);
  }

  const resolved = await Promise.all(
    (rows ?? []).map(async (row) => {
      let url = row.url;
      if (row.source === "upload") {
        const { data, error: signError } = await supabase.storage
          .from("incident-evidence")
          .createSignedUrl(row.url, EVIDENCE_SIGNED_URL_EXPIRY_SECONDS);
        if (!signError && data) {
          url = data.signedUrl;
        } else {
          console.error("[steward_analyse] failed to sign evidence url:", signError);
        }
      }
      return {
        party: row.party as "reporter" | "accused",
        item: { url, label: row.label, source: row.source } as EvidenceItem,
      };
    })
  );

  const reporter: EvidenceItem[] = [
    ...legacyReporterUrls.map((url) => ({ url, label: null, source: "link" as const })),
    ...resolved.filter((r) => r.party === "reporter").map((r) => r.item),
  ];
  const accused: EvidenceItem[] = [
    ...legacyAccusedUrls.map((url) => ({ url, label: null, source: "link" as const })),
    ...resolved.filter((r) => r.party === "accused").map((r) => r.item),
  ];

  return { reporter, accused };
}

// Shared by /steward close and /steward transcript — both need to
// push the full transcript to the league's archive channel as a file
// (a chat message caps at ~2000 chars; a file attachment doesn't).
async function archiveTranscriptToChannel(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  ticketChannelId: string,
  incidentId: string,
  ticketNumber: number | null,
  transcript: string | null
): Promise<string | null> {
  if (!transcript) return null;

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_transcript_channel_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (!leagueConfig?.discord_transcript_channel_id) return null;

  const label = getTicketLabel({ id: incidentId, ticket_number: ticketNumber });
  const sent = await postTicketFile(
    leagueConfig.discord_transcript_channel_id,
    `incident-${label}-transcript.txt`,
    transcript,
    `**Incident ${label}** — transcript archived from <#${ticketChannelId}>`
  );

  if (!sent) {
    console.error(
      `[steward] failed to archive transcript for incident ${incidentId} to configured channel`
    );
    return " ⚠️ Couldn't archive the transcript to the configured channel — check the bot's permissions there.";
  }
  return null;
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

  return {
    defer: true,
    ephemeral: true,
    background: async () => {
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
        return { content: `Couldn't save the close: ${error.message}` };
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

      const archiveWarning = await archiveTranscriptToChannel(
        supabase,
        ctx.leagueId,
        ctx.channelId,
        incident.id,
        incident.ticket_number,
        transcript
      );

      return {
        content: `Ticket closed and transcript saved.${archiveWarning ?? ""}`,
      };
    },
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

  const supabase = createAdminClient();
  const archiveWarning = await archiveTranscriptToChannel(
    supabase,
    ctx.leagueId,
    ctx.channelId,
    incident.id,
    incident.ticket_number,
    transcript
  );

  const preview =
    transcript.length > 1800
      ? `${transcript.slice(0, 1800)}\n… (truncated — full transcript is saved on the incident record)`
      : transcript;

  return {
    content: `\`\`\`\n${preview}\n\`\`\`${archiveWarning ?? ""}`,
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

  return { content: "🗑️ Ticket deleted.", ephemeral: true };
});

registerCommand("steward_adduser", async (ctx) => {
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
    return {
      content: "This ticket is closed — reopen it before adding anyone.",
      ephemeral: true,
    };
  }

  const targetUserId = ctx.options.user as string | undefined;
  if (!targetUserId) {
    return { content: "No user specified.", ephemeral: true };
  }

  const ok = await addUserToTicketChannel(ctx.channelId, targetUserId);
  if (!ok) {
    return { content: "Couldn't add that user — check my permissions.", ephemeral: true };
  }

  const username = ctx.resolvedUsers[targetUserId]?.username ?? targetUserId;
  await postTicketMessage(
    ctx.channelId,
    `➕ <@${targetUserId}> (${username}) was added to this ticket by a steward.`
  );

  return { content: `Added ${username} to the ticket.`, ephemeral: true };
});

// Removing the ticket opener (reporter) is intentionally allowed —
// including from an already-closed ticket, for post-resolution
// cleanup — but is gated behind `force: true` since it hides the
// ticket from the person who filed it. If they're being removed from
// an incident that already has a verdict (resolved/dismissed), they
// get DMed a Yes/No prompt asking if they want to appeal — see
// sendAppealPromptDM in tickets.ts and handleAppealPromptComponent in
// appeal.ts for how the DM buttons are handled.
registerCommand("steward_removeuser", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const targetUserId = ctx.options.user as string | undefined;
  if (!targetUserId) {
    return { content: "No user specified.", ephemeral: true };
  }

  const force = Boolean(ctx.options.force);

  const reporterDiscordId = (incident as any).drivers?.discord_id as
    | string
    | undefined;
  const isOpener = targetUserId === reporterDiscordId;

  if (isOpener && !force) {
    return {
      content:
        "That's the ticket opener (reporter) — removing them hides the ticket from the person who filed it. Re-run with `force: true` if that's really what you want, or close/delete the ticket instead.",
      ephemeral: true,
    };
  }

  const ok = await removeUserFromTicketChannel(ctx.channelId, targetUserId);
  if (!ok) {
    return { content: "Couldn't remove that user — check my permissions.", ephemeral: true };
  }

  const username = ctx.resolvedUsers[targetUserId]?.username ?? targetUserId;
  const openerNote = isOpener ? " (ticket opener)" : "";
  await postTicketMessage(
    ctx.channelId,
    `➖ ${username}${openerNote} was removed from this ticket by a steward.`
  );

  let appealPromptNote = "";
  if (isOpener && (incident.status === "resolved" || incident.status === "dismissed")) {
    const sent = await sendAppealPromptDM(
      targetUserId,
      incident.id,
      getTicketLabel(incident)
    );
    appealPromptNote = sent
      ? " Sent them a DM asking if they'd like to appeal the verdict."
      : " Tried to DM them about appealing but couldn't (they may have DMs disabled).";
  }

  return {
    content: `Removed ${username}${openerNote} from the ticket.${appealPromptNote}`,
    ephemeral: true,
  };
});

registerCommand("steward_respond", async (ctx) => {
  const responseText = ctx.options.response as string;
  const evidenceUrl = ctx.options.evidence as string | undefined;

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();
  let accusedDiscordId: string | undefined;
  if (incident.accused_driver_id) {
    const { data: accusedDriver } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("discord_id")
      .eq("id", incident.accused_driver_id)
      .maybeSingle();
    accusedDiscordId = accusedDriver?.discord_id;
  }

  if (!accusedDiscordId || accusedDiscordId !== ctx.discordUserId) {
    return {
      content: "Only the driver named in this incident can submit a defense.",
      ephemeral: true,
    };
  }

  if (incident.ticket_closed_at) {
    return {
      content: "This ticket is already closed — ask a steward to reopen it if you still need to respond.",
      ephemeral: true,
    };
  }

  const { error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      accused_response: responseText,
      accused_response_at: new Date().toISOString(),
      accused_evidence_urls: evidenceUrl ? [evidenceUrl] : null,
    })
    .eq("id", incident.id);

  if (error) {
    console.error("[steward_respond] update failed:", error);
    return {
      content: `Couldn't save your response: ${error.message}`,
      ephemeral: true,
    };
  }

  await postTicketMessage(
    ctx.channelId,
    [
      `**Defense submitted by <@${ctx.discordUserId}>:**`,
      responseText,
      evidenceUrl ? `POV: ${evidenceUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return { content: "Your response has been recorded.", ephemeral: true };
});

registerCommand("steward_analyse", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const supabase = createAdminClient();

      const { data: fullIncident, error: fetchErr } = await supabase
        .schema("pitboss")
        .from("incidents")
        .select(
          "incident_type, description, season, round, lap, league_id, evidence_urls, accused_response, accused_evidence_urls, ticket_transcript"
        )
        .eq("id", incident.id)
        .single();

      if (fetchErr || !fullIncident) {
        return { content: "Couldn't load the incident details for analysis." };
      }

      const { reporter: reporterEvidence, accused: accusedEvidence } =
        await getIncidentEvidence(
          supabase,
          incident.id,
          fullIncident.evidence_urls ?? [],
          fullIncident.accused_evidence_urls ?? []
        );

      const transcript =
        fullIncident.ticket_transcript ?? (await buildTicketTranscript(ctx.channelId));

      const appBaseUrl = resolveAppBaseUrl();
      if (!appBaseUrl) {
        return {
          content:
            "AI analysis is unavailable right now — the app URL isn't configured on this deployment. Ping the commissioner.",
        };
      }

      const llmRes = await fetch(`${appBaseUrl}/api/pitboss/llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "steward",
          league: fullIncident.league_id,
          fetch_regulations: true,
          incident: {
            incident_type: fullIncident.incident_type,
            description: fullIncident.description,
            season: fullIncident.season,
            round: fullIncident.round,
            lap: fullIncident.lap,
            league_id: fullIncident.league_id,
            reporter_evidence: reporterEvidence,
            accused_response: fullIncident.accused_response ?? null,
            accused_evidence: accusedEvidence,
            ticket_transcript: transcript ?? null,
          },
        }),
      });

      if (!llmRes.ok) {
        console.error("[steward_analyse] LLM call failed:", llmRes.status, await llmRes.text());
        return { content: "AI analysis failed — try again shortly." };
      }

      const ai = await llmRes.json();
      const suggestion = ai.suggestion ?? {};

      const confidenceMap: Record<string, number> = {
        high: 0.9,
        medium: 0.6,
        low: 0.3,
      };

      const pointsMin = suggestion.pp_recommendation?.min ?? 0;
      const pointsMax = suggestion.pp_recommendation?.max ?? pointsMin;
      const confidenceLabel: string = suggestion.confidence ?? "unknown";
      const confidenceScore = confidenceMap[confidenceLabel] ?? 0.5;

      const { error: updateErr } = await supabase
        .schema("pitboss")
        .from("incidents")
        .update({
          ai_verdict: suggestion.verdict ?? null,
          ai_penalty: suggestion.steward_notes ?? null,
          ai_points: pointsMin,
          ai_reasoning: suggestion.reasoning ?? null,
          ai_confidence: confidenceScore,
          ai_articles: suggestion.cited_articles ?? [],
          ai_model: ai.model ?? "unknown",
          ai_analysed_at: new Date().toISOString(),
        })
        .eq("id", incident.id);

      if (updateErr) {
        console.error("[steward_analyse] update failed:", updateErr);
        return { content: `AI analysis ran, but saving the result failed: ${updateErr.message}` };
      }

      const verdict = suggestion.verdict ?? "No verdict returned";
      const stewardNotes = suggestion.steward_notes ?? "None provided";
      const reasoning = suggestion.reasoning ?? "No reasoning provided";
      const articles: string[] = suggestion.cited_articles ?? [];
      const pointsRange =
        pointsMin === pointsMax ? `${pointsMin}` : `${pointsMin}–${pointsMax}`;

      const imageNote = ai.image_analysis
        ? `\n_${ai.image_analysis.image_count} evidence image(s) reviewed._`
        : null;

            const totalEvidenceCount = reporterEvidence.length + accusedEvidence.length;
      // pitboss-proxy now runs a real video-description pass (direct video
      // files, or webpage links resolved via og:video) and reports it back
      // as ai.video_analysis, exactly parallel to ai.image_analysis. This
      // used to unconditionally claim videos were never analyzed --
      // reflect what actually happened on this specific request instead.
      const nonImageCount = [...reporterEvidence, ...accusedEvidence].filter(
        (e) => !/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(e.url.split("?")[0])
      ).length;
      const videoNote = ai.video_analysis
        ? `\n_${ai.video_analysis.video_count} evidence video(s) reviewed._`
        : nonImageCount > 0
          ? `\n_${nonImageCount} video/link evidence item(s) noted but not visually analyzed (link may have expired, failed to load, or had no playable video/thumbnail available)._`
          : null;


      const lines = [
        `**AI Steward Analysis**`,
        `Verdict: ${verdict}`,
        `Suggested penalty points: ${pointsRange}`,
        `Confidence: ${confidenceLabel} (${Math.round(confidenceScore * 100)}%)`,
        articles.length ? `Articles: ${articles.join(", ")}` : null,
        totalEvidenceCount > 0 ? `Evidence items considered: ${totalEvidenceCount}` : null,
        `\n${stewardNotes}`,
        `\n${reasoning}`,
        imageNote,
        videoNote,
        `\nUse \`/steward verdict\` to submit the final ruling.`,
      ].filter(Boolean);

      return { content: lines.join("\n") };
    },
  };
});

registerCommand("steward_verdict", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const verdict = ctx.options.verdict as string;
  const penalty = ctx.options.penalty as string | undefined;
  const penaltyPoints = (ctx.options.points as number) ?? 0;
  const stewardNotes = ctx.options.notes as string | undefined;
  const overrideReason = ctx.options.override_reason as string | undefined;

  const resolverId = await getOrCreateDriverId(ctx.discordUserId);
  const supabase = createAdminClient();

  const { data: updated, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      verdict,
      penalty: penalty ?? null,
      penalty_points: penaltyPoints,
      steward_notes: stewardNotes ?? null,
      override_reason: overrideReason ?? null,
      status: "resolved",
      resolved_by: resolverId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", incident.id)
    .select()
    .single();

  if (error || !updated) {
    console.error("[steward_verdict] update failed:", error);
    return {
      content: `Couldn't save the verdict: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  if (penaltyPoints > 0 && updated.accused_driver_id) {
    const { error: ledgerError } = await supabase
      .schema("pitboss")
      .from("penalty_ledger")
      .insert({
        driver_id: updated.accused_driver_id,
        league_id: updated.league_id,
        incident_id: incident.id,
        points: penaltyPoints,
        reason: `${verdict} — ${penalty ?? "Penalty issued"}`,
      });

    if (ledgerError) {
      console.error("[steward_verdict] penalty_ledger insert failed:", ledgerError);
    }
  }

  await postTicketMessage(
    ctx.channelId,
    [
      `**Verdict:** ${verdict}`,
      penalty ? `**Penalty:** ${penalty}${penaltyPoints ? ` (${penaltyPoints} pts)` : ""}` : null,
      stewardNotes ? `**Notes:** ${stewardNotes}` : null,
      overrideReason ? `**Override reason:** ${overrideReason}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return { content: "Verdict recorded and posted to the ticket.", ephemeral: false };
});

registerCommand("steward_assign", async (ctx) => {
  const denied = await requireHeadSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }
  if (incident.ticket_closed_at) {
    return {
      content: "This ticket is closed — reopen it before reassigning.",
      ephemeral: true,
    };
  }

  const targetUserId = ctx.options.steward as string | undefined;
  if (!targetUserId) {
    return { content: "No steward specified.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const { data: targetDriver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", targetUserId)
    .maybeSingle();

  if (!targetDriver) {
    return {
      content:
        "That user doesn't have a driver record yet — they need to interact with the bot once first.",
      ephemeral: true,
    };
  }

  const { data: targetRole } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_steward")
    .eq("driver_id", targetDriver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (!targetRole?.is_steward) {
    return { content: "That user isn't a steward in this league.", ephemeral: true };
  }

  const assignerDriverId = await getOrCreateDriverId(ctx.discordUserId);

  const { error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      assigned_steward_id: targetDriver.id,
      assigned_by: assignerDriverId,
      assigned_at: new Date().toISOString(),
      help_requested: false,
      help_requested_at: null,
      help_notes: null,
    })
    .eq("id", incident.id);

  if (error) {
    console.error("[steward_assign] update failed:", error);
    return { content: `Couldn't assign the ticket: ${error.message}`, ephemeral: true };
  }

  const username = ctx.resolvedUsers[targetUserId]?.username ?? targetUserId;
  await postTicketMessage(
    ctx.channelId,
    `📋 This ticket has been assigned to <@${targetUserId}> (${username}) by <@${ctx.discordUserId}>.`
  );

  return { content: `Assigned to ${username}.`, ephemeral: true };
});

registerCommand("steward_requesthelp", async (ctx) => {
  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const assignedDiscordId = (incident as any).assigned_steward?.discord_id as
    | string
    | undefined;
  if (!assignedDiscordId || assignedDiscordId !== ctx.discordUserId) {
    return {
      content: "Only the steward this ticket is assigned to can request help.",
      ephemeral: true,
    };
  }
  if (incident.ticket_closed_at) {
    return { content: "This ticket is closed.", ephemeral: true };
  }

  const note = ctx.options.note as string | undefined;
  const supabase = createAdminClient();

  const { error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      help_requested: true,
      help_requested_at: new Date().toISOString(),
      help_notes: note ?? null,
    })
    .eq("id", incident.id);

  if (error) {
    console.error("[steward_requesthelp] update failed:", error);
    return { content: `Couldn't flag this for help: ${error.message}`, ephemeral: true };
  }

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_steward_role_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  const rolePrefix = leagueConfig?.discord_steward_role_id
    ? `<@&${leagueConfig.discord_steward_role_id}> `
    : "";

  await postTicketMessage(
    ctx.channelId,
    [
      `🆘 ${rolePrefix}<@${ctx.discordUserId}> requested assistance on this ticket.`,
      note ? `> ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return { content: "Help requested — stewards have been pinged in the ticket.", ephemeral: true };
});
