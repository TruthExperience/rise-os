import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchScoreboard(groups: number, from: Date, to: Date) {
  const url = `${SCOREBOARD_URL}?dates=${formatDate(from)}-${formatDate(to)}&groups=${groups}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard fetch failed (groups=${groups}): ${res.status}`);
  const json = await res.json();
  return json?.events ?? [];
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);

  const [fbsEvents, fcsEvents] = await Promise.all([
    fetchScoreboard(80, from, to),
    fetchScoreboard(81, from, to),
  ]);
  const events = [...fbsEvents, ...fcsEvents];

  const { data: franchises, error: fErr } = await supabase
    .from("franchises")
    .select("id, espn_team_id")
    .not("espn_team_id", "is", null);

  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 });

  const franchiseByEspnId = new Map(
    (franchises ?? []).map((f) => [String(f.espn_team_id), f.id])
  );

  let logged = 0;
  let skipped = 0;
  const touchedFranchiseIds = new Set<string>();

  for (const event of events) {
    const competition = event.competitions?.[0];
    if (!competition || competition.status?.type?.completed !== true) continue;

    const competitors = competition.competitors ?? [];
    for (const comp of competitors) {
      const espnTeamId = comp.team?.id;
      const franchiseId = franchiseByEspnId.get(String(espnTeamId));
      if (!franchiseId) continue;

      const opponent = competitors.find((c: any) => c.id !== comp.id);
      const teamScore = parseInt(comp.score);
      const opponentScore = parseInt(opponent?.score ?? "0");
      const result =
        teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "T";

      const { error: insertErr } = await supabase.schema("rise_os").from("irl_game_results").insert({
        espn_event_id: event.id,
        franchise_id: franchiseId,
        season: event.season?.year ?? null,
        week: event.week?.number ?? null,
        opponent_name: opponent?.team?.displayName ?? null,
        team_score: teamScore,
        opponent_score: opponentScore,
        result,
        game_date: event.date?.slice(0, 10) ?? null,
      });

      if (insertErr) {
        // unique violation = already logged, safe to skip
        skipped++;
        continue;
      }

      logged++;
      touchedFranchiseIds.add(franchiseId);

      const column =
        result === "W" ? "irl_lifetime_wins" : result === "L" ? "irl_lifetime_losses" : "irl_lifetime_ties";

      const { data: current } = await supabase
        .from("franchises")
        .select(column)
        .eq("id", franchiseId)
        .single();

      const currentValue = (current as any)?.[column] ?? 0;

      await supabase
        .from("franchises")
        .update({
          [column]: currentValue + 1,
          irl_record_source: "espn_api",
          irl_record_updated_at: new Date().toISOString(),
        })
        .eq("id", franchiseId);
    }
  }

  return NextResponse.json({
    eventsScanned: events.length,
    gamesLogged: logged,
    duplicatesSkipped: skipped,
    franchisesUpdated: touchedFranchiseIds.size,
  });
}
