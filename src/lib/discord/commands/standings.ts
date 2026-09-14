import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

// Keeps the leaderboard readable inside a single Discord embed field
// (Discord field values cap at 1024 chars) — /standings limit can ask
// for more, up to 25, but this is the default when omitted.
const DEFAULT_ROWS = 15;
const MAX_ROWS = 25;

/**
 * Resolves the season to show when the caller doesn't pass one —
 * defaults to the highest season that has any standings rows for this
 * league, so a freshly-created season with no results yet doesn't
 * silently render as an empty leaderboard by default.
 */
async function resolveDefaultSeason(leagueId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("driver_standings")
    .select("season")
    .eq("league_id", leagueId)
    .order("season", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) return { error: "No standings recorded yet for this league." } as const;
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

  const { data, error } = await supabase
    .schema("pitboss")
    .from("driver_standings")
    .select(
      "driver_id, wins, top3, poles, dnfs, points, drivers(discord_username, display_name)"
    )
    .eq("league_id", leagueId)
    .eq("season", season)
    .order("points", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[standings] lookup failed:", error);
    return { content: `Something went wrong pulling standings: ${error.message}`, ephemeral: true };
  }

  if (!data || data.length === 0) {
    return { content: `No standings recorded for season ${season}.`, ephemeral: true };
  }

  const rows: StandingsRow[] = data.map((row, i) => {
    const driver = row.drivers as unknown as
      | { discord_username: string; display_name: string | null }
      | null;
    return {
      position: i + 1,
      name: driver?.display_name ?? driver?.discord_username ?? "Unknown",
      points: row.points ?? 0,
      wins: row.wins ?? 0,
      podiums: row.top3 ?? 0,
      poles: row.poles ?? 0,
      dnfs: row.dnfs ?? 0,
    };
  });

  const embed = {
    title: `🏆 ${league.name} — Season ${season} Standings`,
    description: formatStandingsTable(rows),
    thumbnail: league.logo_url ? { url: league.logo_url } : undefined,
    color: 0xe10600,
    footer: {
      text: `Showing top ${rows.length}${data.length === limit ? " — use limit to see more" : ""}`,
    },
  };

  return { embeds: [embed], ephemeral: false };
});
