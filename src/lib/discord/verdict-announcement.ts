import { createAdminClient } from "@/lib/supabase/server";
import { postTicketMessage } from "./tickets";
import { resolveIncidentChannel } from "./incident-channel";

// Posts a resolved verdict to the incident's division channel
// (rise_os.league_divisions.discord_incident_channel_id, e.g. T1 26) the
// moment the ruling is saved.
//
// Only divisions that have their own incident channel set announce; there is
// deliberately no fallback to the league-wide channel, so leagues that never
// linked a division channel see no change.
//
// Never throws and never blocks or fails the ruling itself.
export async function announceVerdict(
  incidentId: string,
  opts: { skipChannelId?: string | null } = {}
): Promise<void> {
  try {
    const supabase = createAdminClient();

    const { data: incident } = await supabase
      .schema("pitboss")
      .from("incidents")
      .select(
        "id, league_id, ticket_number, round, lap, incident_type, accused_driver_id, verdict, penalty, penalty_points, time_penalty_seconds, position_drop, grid_penalty_places, grid_penalty_back, steward_notes, override_reason"
      )
      .eq("id", incidentId)
      .maybeSingle();
    if (!incident || !incident.verdict) return;

    const channelId = await resolveIncidentChannel(incident.league_id, incident.id, null);
    if (!channelId || channelId === opts.skipChannelId) return;

    let accused = "";
    if (incident.accused_driver_id) {
      const { data: driver } = await supabase
        .schema("pitboss")
        .from("drivers")
        .select("discord_id")
        .eq("id", incident.accused_driver_id)
        .maybeSingle();
      if (driver?.discord_id) accused = `<@${driver.discord_id}>`;
    }

    const label =
      incident.ticket_number !== null && incident.ticket_number !== undefined
        ? String(incident.ticket_number).padStart(4, "0")
        : String(incident.id).slice(0, 8);

    const verdictText = String(incident.verdict).replace(/_/g, " ");
    const timeSecs = Number(incident.time_penalty_seconds ?? 0);
    const sporting = [
      timeSecs > 0 ? `${timeSecs}s time penalty` : null,
      incident.position_drop > 0 ? `${incident.position_drop}-place position drop` : null,
      incident.grid_penalty_places > 0 ? `${incident.grid_penalty_places}-place grid penalty` : null,
      incident.grid_penalty_back ? "back-of-grid start" : null,
    ].filter(Boolean);

    const lines = [
      `**Verdict — Incident ${label}**${incident.round ? ` (Round ${incident.round}${incident.lap ? `, lap ${incident.lap}` : ""})` : ""}`,
      accused ? `**Driver:** ${accused}` : null,
      `**Verdict:** ${verdictText.charAt(0).toUpperCase()}${verdictText.slice(1)}`,
      incident.penalty ? `**Reason:** ${incident.penalty}` : null,
      sporting.length ? `**Sporting penalty:** ${sporting.join(", ")}` : null,
      incident.penalty_points > 0 ? `**Penalty points:** ${incident.penalty_points}pp` : null,
      incident.steward_notes ? `**Notes:** ${incident.steward_notes}` : null,
      incident.override_reason ? `**Override reason:** ${incident.override_reason}` : null,
    ].filter(Boolean);

    await postTicketMessage(channelId, lines.join("\n"));
  } catch (err) {
    console.error("[verdict-announcement] failed:", err);
  }
}
