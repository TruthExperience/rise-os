// appeal.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { postTicketMessage, sendDirectMessage, createAppealTicket } from "../tickets";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import { getTicketLabel } from "./steward";

const STEWARD_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_head_steward",
  "is_steward",
] as const;

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

// Same pattern as steward.ts's getOrCreateDriverId — a driver row may
// not exist yet if this is someone's first time touching any command
// that needs one.
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
    console.error("[appeal] driver creation failed:", error);
    return null;
  }
  return created.id;
}

// Appeals happen after an incident's ticket channel may already be
// closed or deleted, so lookup is by the displayed ticket label
// (option input) rather than by channel context like steward.ts's
// findIncidentByChannel.
//
// Sequential ticket numbers take priority: "7" and "0007" both match
// ticket_number = 7 numerically, so leading zeros in the input don't
// matter. Incidents filed before the ticket_number migration still
// have ticket_number = null, so those fall back to the legacy
// UUID-prefix match on the raw input, same as before.
async function findIncidentByShortId(leagueId: string, shortId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select(
      "id, status, verdict, penalty, penalty_points, accused_driver_id, evidence_urls, accused_evidence_urls, ticket_number, drivers!incidents_reported_by_fkey(discord_id)"
    )
    .eq("league_id", leagueId);

  if (error || !data) {
    console.error("[appeal] incident lookup failed:", error);
    return null;
  }

  const trimmed = shortId.trim();

  if (/^\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    const byNumber = data.find((inc) => inc.ticket_number === asNumber);
    if (byNumber) return byNumber;
  }

  return (
    data.find((inc) => inc.ticket_number === null && inc.id.startsWith(trimmed)) ?? null
  );
}

// Merges the legacy flat evidence arrays on incidents with the newer
// per-row incident_evidence table — per pitboss-platform notes, the
// table supersedes the arrays going forward but the arrays are kept
// for backward compatibility on older incidents, so both need to be
// checked for a complete picture.
async function gatherIncidentEvidence(
  incidentId: string,
  reporterEvidenceUrls: unknown,
  accusedEvidenceUrls: unknown
): Promise<{ url: string; label?: string | null; party: string }[]> {
  const supabase = createAdminClient();
  const evidence: { url: string; label?: string | null; party: string }[] = [];

  for (const url of (reporterEvidenceUrls as string[] | null) ?? []) {
    evidence.push({ url, label: null, party: "reporter" });
  }
  for (const url of (accusedEvidenceUrls as string[] | null) ?? []) {
    evidence.push({ url, label: null, party: "accused" });
  }

  const { data: evidenceRows, error } = await supabase
    .schema("pitboss")
    .from("incident_evidence")
    .select("url, label, party")
    .eq("incident_id", incidentId);

  if (error) {
    console.error("[appeal] incident_evidence fetch failed:", error);
  } else if (evidenceRows) {
    for (const row of evidenceRows) {
      evidence.push({ url: row.url, label: row.label, party: row.party });
    }
  }

  return evidence;
}

/**
 * Shared core of "file an appeal": creates the incident_appeals row,
 * flips the incident to appealed, opens the appeal ticket channel if
 * the league has one configured, and posts to the appeals/incident
 * pointer channel. Used by both /appeal file (appellant explicitly
 * runs the command, with a written reason) and
 * handleAppealPromptComponent below (appellant clicked "Yes" on the
 * post-removal DM prompt, no written reason yet — see the placeholder
 * reason used there).
 *
 * Note: the "does this incident already have an open appeal" check
 * happens here, after the caller has already resolved/created the
 * appellant's driver row — a small behavior change from the original
 * /appeal file ordering (which checked first), traded for not
 * duplicating that check across two call sites. Creating a driver row
 * that turns out to be unnecessary is harmless.
 */
async function createAppealRecord(params: {
  incidentId: string;
  leagueId: string;
  ticketLabel: string;
  appellantDiscordId: string;
  appellantDriverId: string;
  reason: string;
  originalVerdict: string | null;
  originalPenalty: string | null;
  originalPenaltyPoints: number | null;
  evidenceUrls: unknown;
  accusedEvidenceUrls: unknown;
  guildId: string;
}): Promise<{ content: string } | { error: string }> {
  const supabase = createAdminClient();

  const { data: existingAppeal } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("id")
    .eq("incident_id", params.incidentId)
    .eq("status", "open")
    .maybeSingle();

  if (existingAppeal) {
    return { error: `Incident **${params.ticketLabel}** already has an open appeal pending review.` };
  }

  const { data: appeal, error } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .insert({
      incident_id: params.incidentId,
      league_id: params.leagueId,
      appealed_by: params.appellantDriverId,
      reason: params.reason,
      original_verdict: params.originalVerdict,
      original_penalty: params.originalPenalty,
      original_penalty_points: params.originalPenaltyPoints,
    })
    .select("id")
    .single();

  if (error || !appeal) {
    console.error("[appeal] createAppealRecord insert failed:", error);
    return { error: `Something went wrong filing the appeal: ${error?.message ?? "unknown error"}` };
  }

  const { error: statusError } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({ status: "appealed" })
    .eq("id", params.incidentId);

  if (statusError) {
    console.error("[appeal] incident status update failed:", statusError);
  }

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select(
      "discord_ticket_category_id, discord_steward_role_id, discord_incident_channel_id, discord_appeals_channel_id"
    )
    .eq("id", params.leagueId)
    .maybeSingle();

  let ticketChannelId: string | null = null;

  if (leagueConfig?.discord_ticket_category_id && leagueConfig?.discord_steward_role_id) {
    const evidence = await gatherIncidentEvidence(
      params.incidentId,
      params.evidenceUrls,
      params.accusedEvidenceUrls
    );

    ticketChannelId = await createAppealTicket({
      guildId: params.guildId,
      categoryId: leagueConfig.discord_ticket_category_id,
      stewardRoleId: leagueConfig.discord_steward_role_id,
      appellantDiscordId: params.appellantDiscordId,
      ticketLabel: params.ticketLabel,
      appealReason: params.reason,
      originalVerdict: params.originalVerdict,
      originalPenalty: params.originalPenalty,
      originalPenaltyPoints: params.originalPenaltyPoints,
      evidence,
    });

    if (ticketChannelId) {
      const { error: channelSaveError } = await supabase
        .schema("pitboss")
        .from("incident_appeals")
        .update({ ticket_channel_id: ticketChannelId })
        .eq("id", appeal.id);
      if (channelSaveError) {
        console.error("[appeal] ticket_channel_id save failed:", channelSaveError);
      }
    }
  }

  // Ping the steward role somewhere durable and discoverable, not just
  // the new per-appeal ticket. Prefer the dedicated appeals channel if
  // this league has one configured; fall back to the general incident
  // channel for leagues that haven't set one up yet.
  const appealsPointerChannel =
    leagueConfig?.discord_appeals_channel_id ?? leagueConfig?.discord_incident_channel_id;

  if (appealsPointerChannel) {
    const pingRole = leagueConfig?.discord_steward_role_id
      ? `<@&${leagueConfig.discord_steward_role_id}> — `
      : "";
    const pointer = ticketChannelId
      ? `see <#${ticketChannelId}> for the appeal ticket.`
      : `Use \`/appeal review\` to rule on it.`;
    await postTicketMessage(
      appealsPointerChannel,
      `${pingRole}**Appeal filed** on incident **${params.ticketLabel}** by <@${params.appellantDiscordId}>.\n${params.reason}\n${pointer}`
    );
  }

  return {
    content: ticketChannelId
      ? `Appeal filed on incident **${params.ticketLabel}** — see <#${ticketChannelId}> for the ticket.`
      : `Appeal filed on incident **${params.ticketLabel}**, but I couldn't open a ticket channel for it. A steward will still see it via \`/appeal status\`.`,
  };
}

registerCommand("appeal_file", async (ctx) => {
  const rawInput = (ctx.options.incident as string).trim();
  const reason = ctx.options.reason as string;

  const incident = await findIncidentByShortId(ctx.leagueId, rawInput);
  if (!incident) {
    return {
      content: `No incident found matching \`${rawInput}\` in this league.`,
      ephemeral: true,
    };
  }

  const ticketLabel = getTicketLabel(incident);

  if (incident.status !== "resolved" && incident.status !== "dismissed") {
    return {
      content: `Incident **${ticketLabel}** is currently *${incident.status}* — only resolved or dismissed incidents can be appealed.`,
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();

  // Confirm the caller is actually a party to this incident — the
  // reporter or the accused driver, same posture as /steward respond.
  const reporterDiscordId = (incident as any).drivers?.discord_id as
    | string
    | undefined;
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

  if (
    ctx.discordUserId !== reporterDiscordId &&
    ctx.discordUserId !== accusedDiscordId
  ) {
    return {
      content: "Only the reporter or the driver named in this incident can file an appeal.",
      ephemeral: true,
    };
  }

  const appellantDriverId = await getOrCreateDriverId(ctx.discordUserId);
  if (!appellantDriverId) {
    return {
      content: "Couldn't set up your driver record — try again in a moment.",
      ephemeral: true,
    };
  }

  const result = await createAppealRecord({
    incidentId: incident.id,
    leagueId: ctx.leagueId,
    ticketLabel,
    appellantDiscordId: ctx.discordUserId,
    appellantDriverId,
    reason,
    originalVerdict: incident.verdict,
    originalPenalty: incident.penalty,
    originalPenaltyPoints: incident.penalty_points,
    evidenceUrls: incident.evidence_urls,
    accusedEvidenceUrls: incident.accused_evidence_urls,
    guildId: ctx.guildId,
  });

  if ("error" in result) {
    return { content: result.error, ephemeral: true };
  }

  return { content: result.content, ephemeral: true };
});

registerCommand("appeal_status", async (ctx) => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("incident_id, reason, created_at, incidents:incident_id(id, ticket_number)")
    .eq("league_id", ctx.leagueId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !data) {
    console.error("[appeal_status] query failed:", error);
    return {
      content: `Couldn't load appeal status: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  if (data.length === 0) {
    return { content: "No open appeals for this league.", ephemeral: true };
  }

  const lines = data.map((a) => {
    const nested = (a as any).incidents;
    const label = nested ? getTicketLabel(nested) : a.incident_id.slice(0, 8);
    return `**${label}** — ${a.reason.slice(0, 80)}`;
  });

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("appeal_review", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const rawInput = (ctx.options.incident as string).trim();
  const decision = ctx.options.decision as "upheld" | "overturned" | "dismissed";
  const newVerdict = ctx.options.new_verdict as string | undefined;
  const newPenalty = ctx.options.new_penalty as string | undefined;
  const newPoints = ctx.options.new_points as number | undefined;
  const notes = ctx.options.notes as string | undefined;

  const incident = await findIncidentByShortId(ctx.leagueId, rawInput);
  if (!incident) {
    return {
      content: `No incident found matching \`${rawInput}\` in this league.`,
      ephemeral: true,
    };
  }

  const ticketLabel = getTicketLabel(incident);

  const supabase = createAdminClient();

  const { data: appeal, error: appealFetchError } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("id, ticket_channel_id")
    .eq("incident_id", incident.id)
    .eq("status", "open")
    .maybeSingle();

  if (appealFetchError || !appeal) {
    return {
      content: `Incident **${ticketLabel}** doesn't have an open appeal.`,
      ephemeral: true,
    };
  }

  const reviewerId = await getOrCreateDriverId(ctx.discordUserId);

  const { error: appealUpdateError } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .update({
      status: decision,
      new_verdict: decision === "overturned" ? newVerdict ?? null : null,
      new_penalty: decision === "overturned" ? newPenalty ?? null : null,
      new_penalty_points: decision === "overturned" ? newPoints ?? null : null,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
      review_notes: notes ?? null,
    })
    .eq("id", appeal.id);

  if (appealUpdateError) {
    console.error("[appeal_review] appeal update failed:", appealUpdateError);
    return {
      content: `Couldn't save the appeal decision: ${appealUpdateError.message}`,
      ephemeral: true,
    };
  }

  const incidentUpdate: Record<string, unknown> = { status: "resolved" };
  if (decision === "overturned") {
    incidentUpdate.verdict = newVerdict ?? incident.verdict;
    incidentUpdate.penalty = newPenalty ?? incident.penalty;
    incidentUpdate.penalty_points = newPoints ?? 0;
  }

  const { error: incidentUpdateError } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update(incidentUpdate)
    .eq("id", incident.id);

  if (incidentUpdateError) {
    console.error("[appeal_review] incident update failed:", incidentUpdateError);
  }

  // On overturn: retire the original penalty_ledger row(s) via the
  // existing soft-delete pattern (removed_at/removed_by) rather than
  // mutating history in place, then issue a fresh row for the revised
  // points if any are owed.
  if (decision === "overturned" && incident.accused_driver_id) {
    const { data: existingLedgerRows } = await supabase
      .schema("pitboss")
      .from("penalty_ledger")
      .select("id")
      .eq("incident_id", incident.id)
      .is("removed_at", null);

    if (existingLedgerRows && existingLedgerRows.length > 0) {
      await supabase
        .schema("pitboss")
        .from("penalty_ledger")
        .update({ removed_at: new Date().toISOString(), removed_by: reviewerId })
        .in("id", existingLedgerRows.map((r) => r.id));
    }

    if ((newPoints ?? 0) > 0) {
      const { error: ledgerError } = await supabase
        .schema("pitboss")
        .from("penalty_ledger")
        .insert({
          driver_id: incident.accused_driver_id,
          league_id: ctx.leagueId,
          incident_id: incident.id,
          points: newPoints,
          reason: `Appeal overturned — ${newVerdict ?? "revised verdict"} — ${newPenalty ?? "revised penalty"}`,
        });
      if (ledgerError) {
        console.error("[appeal_review] penalty_ledger insert failed:", ledgerError);
      }
    }
  }

  // Notify whichever party filed the appeal.
  const { data: appealRow } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("drivers!incident_appeals_appealed_by_fkey(discord_id)")
    .eq("id", appeal.id)
    .maybeSingle();

  const appellantDiscordId = (appealRow as any)?.drivers?.discord_id as
    | string
    | undefined;

  const decisionLines = [
    `Your appeal on incident **${ticketLabel}** has been reviewed: **${decision}**.`,
    decision === "overturned"
      ? `New verdict: ${newVerdict ?? "—"}${newPenalty ? ` — ${newPenalty}` : ""}${
          newPoints !== undefined ? ` (${newPoints} pts)` : ""
        }`
      : null,
    notes ? `Steward notes: ${notes}` : null,
  ].filter(Boolean);

  if (appellantDiscordId) {
    await sendDirectMessage(appellantDiscordId, decisionLines.join("\n"));
  }

  // Also post the outcome into the appeal ticket channel itself, if
  // one was created — otherwise that channel never hears the result.
  if (appeal.ticket_channel_id) {
    await postTicketMessage(appeal.ticket_channel_id, decisionLines.join("\n"));
  }

  // And post it into the league's dedicated appeals channel too, if
  // configured — this is the one place a decision is guaranteed to be
  // visible even after a per-appeal ticket channel gets deleted, and
  // it's where /appeal_file's "filed" pointer already goes, so the
  // full filed → decided history lives in one place.
  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_appeals_channel_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  if (leagueConfig?.discord_appeals_channel_id) {
    await postTicketMessage(
      leagueConfig.discord_appeals_channel_id,
      `**Appeal decided** — incident **${ticketLabel}**: **${decision}**.\n${decisionLines.slice(1).join("\n")}`
    );
  }

  return {
    content: `Appeal on incident **${ticketLabel}** marked **${decision}**.`,
    ephemeral: true,
  };
});

/**
 * Handles the Yes/No buttons sent by tickets.ts's sendAppealPromptDM
 * (fired from /steward removeuser when force-removing a ticket
 * opener from an already-resolved/dismissed incident).
 *
 * NOT wired up via registerCommand — this is a MESSAGE_COMPONENT
 * interaction, not a slash command. Wherever the top-level Discord
 * interaction handler currently does something like:
 *
 *   if (interaction.type === APPLICATION_COMMAND) {
 *     return runRegisteredCommand(interaction, ...);
 *   }
 *
 * it needs an additional branch:
 *
 *   if (
 *     interaction.type === MESSAGE_COMPONENT &&
 *     interaction.data.custom_id.startsWith("appeal_prompt:")
 *   ) {
 *     const discordUserId =
 *       interaction.member?.user?.id ?? interaction.user?.id;
 *     const reply = await handleAppealPromptComponent(
 *       interaction.data.custom_id,
 *       discordUserId
 *     );
 *     // Respond with interaction response type 7 (UPDATE_MESSAGE) so
 *     // the buttons on the original DM don't stay clickable:
 *     //   { type: 7, data: { content: reply.content, components: [] } }
 *   }
 *
 * custom_id shape: "appeal_prompt:yes:<incidentId>" or
 * "appeal_prompt:no:<incidentId>". The clicking user's identity comes
 * from the interaction payload itself (not the custom_id), then gets
 * cross-checked against the incident's reported_by driver below, so a
 * button in someone else's DM can't be replayed against this incident.
 */
export async function handleAppealPromptComponent(
  customId: string,
  discordUserId: string
): Promise<{ content: string }> {
  const [, answer, incidentId] = customId.split(":");

  if (answer === "no") {
    return {
      content:
        "No appeal filed. If you change your mind, you can still use `/appeal file` before the appeal window closes.",
    };
  }

  if (answer !== "yes" || !incidentId) {
    return { content: "Something went wrong reading that response." };
  }

  const supabase = createAdminClient();

  const { data: incident, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select(
      "id, league_id, status, verdict, penalty, penalty_points, evidence_urls, accused_evidence_urls, ticket_number, reported_by"
    )
    .eq("id", incidentId)
    .maybeSingle();

  if (error || !incident) {
    console.error("[appeal] handleAppealPromptComponent incident fetch failed:", error);
    return { content: "Couldn't find that incident anymore — it may have been deleted." };
  }

  const ticketLabel = getTicketLabel(incident);

  // Only the original reporter this prompt was sent to can act on it.
  const { data: reporterDriver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("discord_id")
    .eq("id", incident.reported_by)
    .maybeSingle();

  if (reporterDriver?.discord_id !== discordUserId) {
    return { content: "This appeal prompt wasn't for you." };
  }

  if (incident.status !== "resolved" && incident.status !== "dismissed") {
    return {
      content: `Incident **${ticketLabel}** is currently *${incident.status}* — only resolved or dismissed incidents can be appealed.`,
    };
  }

  const appellantDriverId = await getOrCreateDriverId(discordUserId);
  if (!appellantDriverId) {
    return { content: "Couldn't set up your driver record — try again in a moment." };
  }

  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_server_id")
    .eq("id", incident.league_id)
    .maybeSingle();

  if (!leagueConfig?.discord_server_id) {
    console.error(`[appeal] no discord_server_id configured for league ${incident.league_id}`);
    return {
      content: `Couldn't open an appeal ticket automatically — ask a steward to run \`/appeal file\` on your behalf for incident **${ticketLabel}**.`,
    };
  }

  const result = await createAppealRecord({
    incidentId: incident.id,
    leagueId: incident.league_id,
    ticketLabel,
    appellantDiscordId: discordUserId,
    appellantDriverId,
    reason:
      "Appeal requested via post-removal DM prompt — no written reason provided yet. Add detail with a follow-up message in the appeal ticket.",
    originalVerdict: incident.verdict,
    originalPenalty: incident.penalty,
    originalPenaltyPoints: incident.penalty_points,
    evidenceUrls: incident.evidence_urls,
    accusedEvidenceUrls: incident.accused_evidence_urls,
    guildId: leagueConfig.discord_server_id,
  });

  if ("error" in result) {
    return { content: result.error };
  }

  return { content: result.content };
}
