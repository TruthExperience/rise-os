import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

// Keeps the leaderboard readable inside a single Discord embed field
// (Discord field values cap at 1024 chars) — /standings limit can ask
// for more, up to 25, but this is the default when omitted.
const DEFAULT_ROWS = 15;
const MAX_ROWS = 25;

/**
 * PATCH (2026-09-14): standings is now computed live from pitboss.results
 * instead of reading pitboss.driver_standings. That rollup table has 0
 * rows platform-wide — nothing (no trigger, no job) ever wrote to it, so
 * /standings was silently empty for every league regardless of how many
 * results had been recorded. Computing live from results avoids needing
 * a separate rollup/aggregation pipeline; if per-season result volume
 * grows large enough that this gets slow, revisit with a maintained
 * rollup table + trigger instead.
 */

/**
 * Resolves the season to show when the caller doesn't pass one —
 * defaults to the highest season that has any results recorded for this
 * league, so a freshly-created season with no results yet doesn't
 * silently render as an empty leaderboard by default.
 */
async function resolveDefaultSeason(leagueId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("results")
    .select("season")
    .eq("league_id", leagueId)
    .order("season", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) return { error: "No results recorded yet for this league." } as const;
  return { season: data.season as string } as const;
}

interface StandingsRow {
  position: number;
  name: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  dnfs: number;
}

/**
 * Fixed-width monospace table rendered inside a code block — same
 * approach Discord bots commonly use for tabular data since embeds
 * don't support real tables. Name is truncated to keep every row (and
 * the whole block, at MAX_ROWS) comfortably under the 1024-char field
 * limit.
 */
function formatStandingsTable(rows: StandingsRow[]): string {
  const header = `#  Driver              Pts  Wins  Pod  Pole  DNF`;
  const lines = rows.map((r) => {
    const pos = `${r.position}`.padStart(2, " ");
    const name =
      r.name.length > 16 ? r.name.slice(0, 15) + "…" : r.name.padEnd(16, " ");
    const pts = `${r.points}`.padStart(4, " ");
    const wins = `${r.wins}`.padStart(4, " ");
    const pod = `${r.podiums}`.padStart(4, " ");
    const pole = `${r.poles}`.padStart(4, " ");
    const dnf = `${r.dnfs}`.padStart(4, " ");
    return `${pos} ${name} ${pts} ${wins} ${pod} ${pole} ${dnf}`;
  });
  return ["```", header, ...lines, "```"].join("\n");
}

registerCommand("standings", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const { data: league, error: leagueError } = await supabase
    .schema("pitboss")
    .from("leagues")
    .select("name, logo_url")
    .eq("id", leagueId)
    .single();

  if (leagueError || !league) {
    return { content: "Couldn't find this league's details.", ephemeral: true };
  }

  let season = ctx.options.season as string | undefined;
  if (!season) {
    const seasonResult = await resolveDefaultSeason(leagueId);
    if ("error" in seasonResult) {
      return { content: seasonResult.error, ephemeral: true };
    }
    season = seasonResult.season;
  }

  const limitInput = ctx.options.limit as number | undefined;
  const limit =
    limitInput && limitInput > 0 ? Math.min(Math.floor(limitInput), MAX_ROWS) : DEFAULT_ROWS;

  // Pull every result row for the season and aggregate per driver here,
  // rather than reading a maintained rollup table (see PATCH note above).
  const { data, error } = await supabase
    .schema("pitboss")
    .from("results")
    .select(
      "driver_id, finish_position, dnf, qualifying_position, points_earned, sprint_points_earned, drivers(discord_username, display_name)"
    )
    .eq("league_id", leagueId)
    .eq("season", season);

  if (error) {
    console.error("[standings] lookup failed:", error);
    return { content: `Something went wrong pulling results: ${error.message}`, ephemeral: true };
  }

  if (!data || data.length === 0) {
    return { content: `No results recorded for season ${season}.`, ephemeral: true };
  }

  interface Accumulator {
    name: string;
    points: number;
    wins: number;
    podiums: number;
    poles: number;
    dnfs: number;
  }

  const byDriver = new Map<string, Accumulator>();

  for (const row of data) {
    const driver = row.drivers as unknown as
      | { discord_username: string; display_name: string | null }
      | null;
    const name = driver?.display_name ?? driver?.discord_username ?? "Unknown";

    const existing = byDriver.get(row.driver_id) ?? {
      name,
      points: 0,
      wins: 0,
      podiums: 0,
      poles: 0,
      dnfs: 0,
    };

    existing.points += (row.points_earned ?? 0) + (row.sprint_points_earned ?? 0);
    if (!row.dnf && row.finish_position === 1) existing.wins += 1;
    if (!row.dnf && row.finish_position != null && row.finish_position <= 3) existing.podiums += 1;
    if (row.qualifying_position === 1) existing.poles += 1;
    if (row.dnf) existing.dnfs += 1;

    byDriver.set(row.driver_id, existing);
  }

  const sorted = [...byDriver.values()].sort((a, b) => b.points - a.points);
  const limited = sorted.slice(0, limit);

  const rows: StandingsRow[] = limited.map((r, i) => ({
    position: i + 1,
    name: r.name,
    points: r.points,
    wins: r.wins,
    podiums: r.podiums,
    poles: r.poles,
    dnfs: r.dnfs,
  }));

  const embed = {
    title: `🏆 ${league.name} — Season ${season} Standings`,
    description: formatStandingsTable(rows),
    thumbnail: league.logo_url ? { url: league.logo_url } : undefined,
    color: 0xe10600,
    footer: {
      text: `Showing top ${rows.length}${sorted.length > limit ? " — use limit to see more" : ""}`,
    },
  };

  return { embeds: [embed], ephemeral: false };
});
