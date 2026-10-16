import { createAdminClient } from "@/lib/supabase/server";

// Which channel is "the incident channel" for a given incident?
//
// Leagues with tiers keep one incident channel per division, stored on
// rise_os.league_divisions.discord_incident_channel_id (set with
// `/division link code:T1 incident_channel:#...`). An incident has no
// division of its own, so it's resolved from the accused driver's active
// division (falling back to the reporter's). If neither has a division, or
// that division has no channel, the league-wide
// rise_os.leagues.discord_incident_channel_id (/setup reports_channel) is used.
//
// Never throws; returns the fallback on any lookup problem.
export function resolveIncidentChannel(
  leagueId: string,
  incidentId: string,
  leagueDefault: string | null | undefined
): Promise<string | null> {
  return resolveDivisionChannel(leagueId, incidentId, "discord_incident_channel_id", leagueDefault);
}

// Same lookup for the transcript archive channel
// (rise_os.league_divisions.discord_transcript_channel_id, falling back to
// rise_os.leagues.discord_transcript_channel_id).
export function resolveTranscriptChannel(
  leagueId: string,
  incidentId: string,
  leagueDefault: string | null | undefined
): Promise<string | null> {
  return resolveDivisionChannel(leagueId, incidentId, "discord_transcript_channel_id", leagueDefault);
}

async function resolveDivisionChannel(
  leagueId: string,
  incidentId: string,
  column: "discord_incident_channel_id" | "discord_transcript_channel_id",
  leagueDefault: string | null | undefined
): Promise<string | null> {
  const fallback = leagueDefault ?? null;
  try {
    const supabase = createAdminClient();

    const { data: incident } = await supabase
      .schema("pitboss")
      .from("incidents")
      .select("accused_driver_id, reported_by")
      .eq("id", incidentId)
      .maybeSingle();
    if (!incident) return fallback;

    // Accused first, then reporter.
    for (const driverId of [incident.accused_driver_id, incident.reported_by]) {
      if (!driverId) continue;

      const { data: member } = await supabase
        .schema("pitboss")
        .from("division_members")
        .select("division_id")
        .eq("driver_id", driverId)
        .eq("league_id", leagueId)
        .eq("active", true)
        .maybeSingle();
      if (!member) continue;

      const { data: division } = await supabase
        .schema("rise_os")
        .from("league_divisions")
        .select(column)
        .eq("id", member.division_id)
        .maybeSingle();
      const channel = (division as Record<string, string | null> | null)?.[column];
      if (channel) return channel;
    }
    return fallback;
  } catch (err) {
    console.error("[incident-channel] resolve failed:", err);
    return fallback;
  }
}
