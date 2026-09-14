import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveRound } from "./checkin";

/**
 * Formats a finishing position with DNF handling. qualifying_position and
 * finish_position are both nullable in the schema (result may be entered
 * before quali is known, or a driver DNF'd with no classified finish).
 */
function formatPosition(position: number | null, dnf: boolean | null): string {
  if (dnf) return "DNF";
  if (position == null) return "—";
  return `P${position}`;
}

interface ResultRow {
  driverName: string;
  qualifying: string;
  finish: string;
  points: number;
  fastestLap: boolean;
  sprintFinish: string | null;
  sprintPoints: number;
}

/**
 * Same fixed-width code-block table approach as /standings, so the two
 * commands read consistently. Sprint columns only render when at least
 * one row in the result set has sprint data — most rounds won't.
 */
function formatResultsTable(rows: ResultRow[], includeSprint: boolean): string {
  const header = includeSprint
    ? `Driver              Quali  Finish  Pts  Sprint  SPts`
    : `Driver              Quali  Finish  Pts`;
  const lines = rows.map((r) => {
    const name = r.driverName.length > 16 ? r.driverName.slice(0, 15) + "…" : r.driverName.padEnd(16, " ");
    const quali = r.qualifying.padStart(5, " ");
    const finish = (r.fastestLap ? r.finish + "*" : r.finish).padStart(6, " ");
    const pts = `${r.points}`.padStart(4, " ");
    if (!includeSprint) return `${name} ${quali}  ${finish}  ${pts}`;
    const sprint = (r.sprintFinish ?? "—").padStart(6, " ");
    const sprintPts = `${r.sprintPoints}`.padStart(5, " ");
    return `${name} ${quali}  ${finish}  ${pts}  ${sprint}  ${sprintPts}`;
  });
  const footer = "* = fastest lap";
  return ["```", header, ...lines, "```", formatFootnote(rows, footer)].filter(Boolean).join("\n");
}

function formatFootnote(rows: ResultRow[], footer: string): string {
  return rows.some((r) => r.fastestLap) ? footer : "";
}

registerCommand("results", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const roundResult = await resolveRound(
    leagueId,
    ctx.options.round as string | undefined,
    ctx.options.season as string | undefined
  );
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const { data, error } = await supabase
    .schema("pitboss")
    .from("results")
    .select(
      "qualifying_position, finish_position, dnf, fastest_lap, points_earned, sprint_finish_position, sprint_dnf, sprint_points_earned, drivers(discord_username, display_name)"
    )
    .eq("league_id", leagueId)
    .eq("round_id", round.id)
    .order("finish_position", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("[results] lookup failed:", error);
    return { content: `Something went wrong pulling results: ${error.message}`, ephemeral: true };
  }

  if (!data || data.length === 0) {
    return { content: `No results recorded yet for ${round.name ?? `round ${round.round_number}`}.`, ephemeral: true };
  }

  const includeSprint = data.some((r) => r.sprint_finish_position != null || r.sprint_dnf);

  const rows: ResultRow[] = data.map((row) => {
    const driver = row.drivers as unknown as
      | { discord_username: string; display_name: string | null }
      | null;
    return {
      driverName: driver?.display_name ?? driver?.discord_username ?? "Unknown",
      qualifying: row.qualifying_position != null ? `P${row.qualifying_position}` : "—",
      finish: formatPosition(row.finish_position, row.dnf),
      points: row.points_earned ?? 0,
      fastestLap: row.fastest_lap ?? false,
      sprintFinish: includeSprint ? formatPosition(row.sprint_finish_position, row.sprint_dnf) : null,
      sprintPoints: row.sprint_points_earned ?? 0,
    };
  });

  const embed = {
    title: `🏁 ${round.name ?? `Round ${round.round_number}`} — Results`,
    description: formatResultsTable(rows, includeSprint),
    color: 0xe10600,
  };

  return { embeds: [embed], ephemeral: false };
});
