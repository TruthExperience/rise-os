import { createAdminClient } from "@/lib/supabase/server";
import {
  createAppealTicket,
  createIncidentTicket,
  postTicketMessage,
  sendDirectMessage,
} from "./tickets";
import { resolveEvidenceList } from "./evidence-storage";

type Db = ReturnType<typeof createAdminClient>;

export type OpenTicketResult =
  | { ok: true; channelId: string | null; alreadyOpen: boolean; note?: string }
  | { ok: false; error: string };

// Same label rule as steward.ts's getTicketLabel, re-declared so the app
// doesn't import the slash-command module (it registers commands on import).
function ticketLabel(incident: { id: string; ticket_number: number | null }): string {
  if (incident.ticket_number !== null && incident.ticket_number !== undefined) {
    return String(incident.ticket_number).padStart(4, "0");
  }
  return incident.id.slice(0, 8);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Legacy flat evidence arrays + the incident_evidence table, with uploads
// swapped for fresh signed URLs (same merge as appeal.ts).
async function gatherIncidentEvidence(
  supabase: Db,
  incidentId: string,
  reporterEvidenceUrls: unknown,
  accusedEvidenceUrls: unknown
): Promise<{ url: string; label?: string | null; party: string }[]> {
  const evidence: { url: string; label?: string | null; party: string; source?: string }[] = [];

  for (const url of (reporterEvidenceUrls as string[] | null) ?? []) {
    evidence.push({ url, label: null, party: "reporter", source: "link" });
  }
  for (const url of (accusedEvidenceUrls as string[] | null) ?? []) {
    evidence.push({ url, label: null, party: "accused", source: "link" });
  }

  const { data: rows, error } = await supabase
    .schema("pitboss")
    .from("incident_evidence")
    .select("url, label, party, source")
    .eq("incident_id", incidentId);

  if (error) {
    console.error("[app-sync] incident_evidence fetch failed:", error);
  } else if (rows) {
    for (const row of rows) {
      evidence.push({ url: row.url, label: row.label, party: row.party, source: row.source });
    }
  }

  const resolved = await resolveEvidenceList(evidence);
  return resolved.map(({ url, label, party }) => ({ url, label, party }));
}

async function loadLeagueConfig(supabase: Db, leagueId: string) {
  const { data } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select(
      "discord_server_id, discord_ticket_category_id, discord_steward_role_id, discord_incident_channel_id, discord_appeals_channel_id"
    )
    .eq("id", leagueId)
    .maybeSingle();
  return data;
}

async function loadDiscordIds(supabase: Db, driverIds: (string | null)[]) {
  const ids = driverIds.filter((id): id is string => Boolean(id));
  const map = new Map<string, { discord_id: string | null; name: string }>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id, discord_id, discord_username, display_name")
    .in("id", ids);
  for (const d of data ?? []) {
    map.set(d.id, {
      discord_id: d.discord_id,
      name: d.display_name || d.discord_username || "a driver",
    });
  }
  return map;
}

/**
 * Opens the Discord side of an incident that already exists in the database:
 * creates the private incident-XXXX channel, saves ticket_channel_id, and DMs
 * the accused. Safe to call twice; never throws.
 */
export async function openDiscordIncidentTicket(incidentId: string): Promise<OpenTicketResult> {
  try {
    const supabase = createAdminClient();

    const { data: incident, error } = await supabase
      .schema("pitboss")
      .from("incidents")
      .select(
        "id, league_id, reported_by, accused_driver_id, incident_type, description, lap, round, ticket_number, ticket_channel_id, evidence_urls"
      )
      .eq("id", incidentId)
      .maybeSingle();

    if (error || !incident) return { ok: false, error: "Incident not found." };
    if (incident.ticket_channel_id) {
      return { ok: true, channelId: incident.ticket_channel_id, alreadyOpen: true };
    }

    const config = await loadLeagueConfig(supabase, incident.league_id);
    if (
      !config?.discord_server_id ||
      !config.discord_ticket_category_id ||
      !config.discord_steward_role_id
    ) {
      return {
        ok: true,
        channelId: null,
        alreadyOpen: false,
        note: "League has no Discord server, ticket category or steward role configured.",
      };
    }

    const drivers = await loadDiscordIds(supabase, [incident.reported_by, incident.accused_driver_id]);
    const reporter = incident.reported_by ? drivers.get(incident.reported_by) : undefined;
    const accused = incident.accused_driver_id ? drivers.get(incident.accused_driver_id) : undefined;

    if (!reporter?.discord_id) {
      return {
        ok: true,
        channelId: null,
        alreadyOpen: false,
        note: "Reporter has no linked Discord account, so there is nobody to open the ticket for.",
      };
    }

    const label = ticketLabel(incident);
    const evidence = await gatherIncidentEvidence(supabase, incident.id, incident.evidence_urls, null);
    const evidenceUrls = evidence.filter((e) => e.party === "reporter").map((e) => e.url);

    const channelId = await createIncidentTicket({
      guildId: config.discord_server_id,
      categoryId: config.discord_ticket_category_id,
      stewardRoleId: config.discord_steward_role_id,
      reporterDiscordId: reporter.discord_id,
      accusedDiscordId: accused?.discord_id ?? null,
      ticketLabel: label,
      incidentType: incident.incident_type,
      description: clip(incident.description ?? "", 1200),
      lap: incident.lap,
      round: incident.round,
      evidenceUrls,
    });

    if (!channelId) {
      return { ok: true, channelId: null, alreadyOpen: false, note: "Discord channel creation failed." };
    }

    const { error: saveError } = await supabase
      .schema("pitboss")
      .from("incidents")
      .update({ ticket_channel_id: channelId })
      .eq("id", incident.id);
    if (saveError) console.error("[app-sync] incident ticket_channel_id save failed:", saveError);

    if (accused?.discord_id) {
      const dm = [
        `You've been named in an incident report — **${label}** (${incident.incident_type}) — filed against you.`,
        `\n${clip(incident.description ?? "", 1000)}`,
        `\nRespond with your side in <#${channelId}> using \`/steward respond\` — you can include your own POV link or file.`,
      ].join("\n");
      await sendDirectMessage(accused.discord_id, dm);
    }

    return { ok: true, channelId, alreadyOpen: false };
  } catch (err) {
    console.error("[app-sync] openDiscordIncidentTicket failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Opens the Discord side of an appeal that already exists in
 * pitboss.incident_appeals: creates the private appeal-XXXX channel, saves
 * ticket_channel_id, and posts the "Appeal filed" pointer in the appeals (or
 * incident) channel. Safe to call twice; never throws.
 */
export async function openDiscordAppealTicket(appealId: string): Promise<OpenTicketResult> {
  try {
    const supabase = createAdminClient();

    const { data: appeal, error: appealError } = await supabase
      .schema("pitboss")
      .from("incident_appeals")
      .select(
        "id, incident_id, league_id, appealed_by, reason, original_verdict, original_penalty, original_penalty_points, ticket_channel_id"
      )
      .eq("id", appealId)
      .maybeSingle();

    if (appealError || !appeal) return { ok: false, error: "Appeal not found." };
    if (appeal.ticket_channel_id) {
      return { ok: true, channelId: appeal.ticket_channel_id, alreadyOpen: true };
    }

    const { data: incident } = await supabase
      .schema("pitboss")
      .from("incidents")
      .select("id, ticket_number, evidence_urls, accused_evidence_urls")
      .eq("id", appeal.incident_id)
      .maybeSingle();
    if (!incident) return { ok: false, error: "Incident for this appeal not found." };

    const config = await loadLeagueConfig(supabase, appeal.league_id);
    const drivers = await loadDiscordIds(supabase, [appeal.appealed_by]);
    const appellant = drivers.get(appeal.appealed_by);

    const label = ticketLabel(incident);
    let channelId: string | null = null;
    let note: string | undefined;

    if (
      config?.discord_server_id &&
      config.discord_ticket_category_id &&
      config.discord_steward_role_id &&
      appellant?.discord_id
    ) {
      const evidence = await gatherIncidentEvidence(
        supabase,
        incident.id,
        incident.evidence_urls,
        incident.accused_evidence_urls
      );

      channelId = await createAppealTicket({
        guildId: config.discord_server_id,
        categoryId: config.discord_ticket_category_id,
        stewardRoleId: config.discord_steward_role_id,
        appellantDiscordId: appellant.discord_id,
        ticketLabel: label,
        appealReason: clip(appeal.reason, 1500),
        originalVerdict: appeal.original_verdict,
        originalPenalty: appeal.original_penalty,
        originalPenaltyPoints: appeal.original_penalty_points,
        evidence,
      });

      if (channelId) {
        const { error: saveError } = await supabase
          .schema("pitboss")
          .from("incident_appeals")
          .update({ ticket_channel_id: channelId })
          .eq("id", appeal.id);
        if (saveError) console.error("[app-sync] appeal ticket_channel_id save failed:", saveError);
      } else {
        note = "Discord channel creation failed.";
      }
    } else {
      note = !appellant?.discord_id
        ? "Appellant has no linked Discord account, so no ticket channel was opened."
        : "League has no Discord server, ticket category or steward role configured.";
    }

    const pointerChannel = config?.discord_appeals_channel_id ?? config?.discord_incident_channel_id;
    if (pointerChannel) {
      const pingRole = config?.discord_steward_role_id ? `<@&${config.discord_steward_role_id}> — ` : "";
      const who = appellant?.discord_id ? `<@${appellant.discord_id}>` : appellant?.name ?? "a driver";
      const pointer = channelId
        ? `see <#${channelId}> for the appeal ticket.`
        : `Use \`/appeal review\` to rule on it.`;
      await postTicketMessage(
        pointerChannel,
        `${pingRole}**Appeal filed** on incident **${label}** by ${who}.\n${clip(appeal.reason, 1200)}\n${pointer}`
      );
    }

    return { ok: true, channelId, alreadyOpen: false, note };
  } catch (err) {
    console.error("[app-sync] openDiscordAppealTicket failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
