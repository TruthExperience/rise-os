import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { postTicketMessage, sendDirectMessage } from "../tickets";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

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
// closed or deleted, so lookup is by short ID (option input) rather
// than by channel context like steward.ts's findIncidentByChannel.
// Incident volume per league is low enough that fetching the league's
// incidents and matching client-side is simpler and cheap versus
// wrestling with a uuid-prefix filter in PostgREST.
async function findIncidentByShortId(leagueId: string, shortId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select(
      "id, status, verdict, penalty, penalty_points, accused_driver_id, drivers!incidents_reported_by_fkey(discord_id)"
    )
    .eq("league_id", leagueId);

  if (error || !data) {
    console.error("[appeal] incident lookup failed:", error);
    return null;
  }

  return data.find((inc) => inc.id.startsWith(shortId)) ?? null;
}

registerCommand("appeal_file", async (ctx) => {
  const shortId = (ctx.options.incident as string).trim();
  const reason = ctx.options.reason as string;

  const incident = await findIncidentByShortId(ctx.leagueId, shortId);
  if (!incident) {
    return {
      content: `No incident found matching \`${shortId}\` in this league.`,
      ephemeral: true,
    };
  }

  if (incident.status !== "resolved" && incident.status !== "dismissed") {
    return {
      content: `Incident **${shortId}** is currently *${incident.status}* — only resolved or dismissed incidents can be appealed.`,
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

  // One open appeal per incident at a time.
  const { data: existingAppeal } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("id")
    .eq("incident_id", incident.id)
    .eq("status", "open")
    .maybeSingle();

  if (existingAppeal) {
    return {
      content: `Incident **${shortId}** already has an open appeal pending review.`,
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

  const { error } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .insert({
      incident_id: incident.id,
      league_id: ctx.leagueId,
      appealed_by: appellantDriverId,
      reason,
      original_verdict: incident.verdict,
      original_penalty: incident.penalty,
      original_penalty_points: incident.penalty_points,
    });

  if (error) {
    console.error("[appeal_file] insert failed:", error);
    return {
      content: `Something went wrong filing the appeal: ${error.message}`,
      ephemeral: true,
    };
  }

  const { error: statusError } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({ status: "appealed" })
    .eq("id", incident.id);

  if (statusError) {
    console.error("[appeal_file] incident status update failed:", statusError);
  }

  // Ping the steward role in the league's general incident channel
  // (not the ticket channel — that may be gone by now).
  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_incident_channel_id, discord_steward_role_id")
    .eq("id", ctx.leagueId)
    .maybeSingle();

  if (leagueConfig?.discord_incident_channel_id) {
    const pingRole = leagueConfig.discord_steward_role_id
      ? `<@&${leagueConfig.discord_steward_role_id}> — `
      : "";
    await postTicketMessage(
      leagueConfig.discord_incident_channel_id,
      `${pingRole}**Appeal filed** on incident **${shortId}** by <@${ctx.discordUserId}>.\n${reason}\nUse \`/appeal review\` to rule on it.`
    );
  }

  return {
    content: `Appeal filed on incident **${shortId}**. A steward will review it.`,
    ephemeral: true,
  };
});

registerCommand("appeal_status", async (ctx) => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("incident_id, reason, created_at")
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

  const lines = data.map(
    (a) => `**${a.incident_id.slice(0, 8)}** — ${a.reason.slice(0, 80)}`
  );

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("appeal_review", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const shortId = (ctx.options.incident as string).trim();
  const decision = ctx.options.decision as "upheld" | "overturned" | "dismissed";
  const newVerdict = ctx.options.new_verdict as string | undefined;
  const newPenalty = ctx.options.new_penalty as string | undefined;
  const newPoints = ctx.options.new_points as number | undefined;
  const notes = ctx.options.notes as string | undefined;

  const incident = await findIncidentByShortId(ctx.leagueId, shortId);
  if (!incident) {
    return {
      content: `No incident found matching \`${shortId}\` in this league.`,
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();

  const { data: appeal, error: appealFetchError } = await supabase
    .schema("pitboss")
    .from("incident_appeals")
    .select("id")
    .eq("incident_id", incident.id)
    .eq("status", "open")
    .maybeSingle();

  if (appealFetchError || !appeal) {
    return {
      content: `Incident **${shortId}** doesn't have an open appeal.`,
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
  if (appellantDiscordId) {
    const dmLines = [
      `Your appeal on incident **${shortId}** has been reviewed: **${decision}**.`,
      decision === "overturned"
        ? `New verdict: ${newVerdict ?? "—"}${newPenalty ? ` — ${newPenalty}` : ""}${
            newPoints !== undefined ? ` (${newPoints} pts)` : ""
          }`
        : null,
      notes ? `Steward notes: ${notes}` : null,
    ].filter(Boolean);
    await sendDirectMessage(appellantDiscordId, dmLines.join("\n"));
  }

  return {
    content: `Appeal on incident **${shortId}** marked **${decision}**.`,
    ephemeral: true,
  };
});
