import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

type ResultRow = {
  league_id: string;
  franchise_id: string | null;
  season: string;
  finish_position: number | null;
  qualifying_position: number | null;
  dnf: boolean | null;
  fastest_lap: boolean | null;
  points_earned: number | null;
};

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: results, error } = await supabase
    .from("results")
    .select(
      "league_id, franchise_id, season, finish_position, qualifying_position, dnf, fastest_lap, points_earned"
    )
    .not("franchise_id", "is", null)
    .returns<ResultRow[]>();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // --- 1. Overall franchise race record (all-time, across all leagues/seasons the franchise raced in) ---
  const byFranchise = new Map<string, ResultRow[]>();
  for (const r of results ?? []) {
    if (!r.franchise_id) continue;
    if (!byFranchise.has(r.franchise_id)) byFranchise.set(r.franchise_id, []);
    byFranchise.get(r.franchise_id)!.push(r);
  }

  let franchisesUpdated = 0;
  for (const [franchiseId, rows] of byFranchise.entries()) {
    const classified = rows.filter((r) => !r.dnf && r.finish_position != null);

    const stats = {
      race_starts: rows.length,
      race_wins: classified.filter((r) => r.finish_position === 1).length,
      race_top3: classified.filter((r) => (r.finish_position as number) <= 3).length,
      race_top5: classified.filter((r) => (r.finish_position as number) <= 5).length,
      race_top10: classified.filter((r) => (r.finish_position as number) <= 10).length,
    };

    const { error: updateErr } = await supabase
      .from("franchises")
      .update(stats)
      .eq("id", franchiseId);

    if (!updateErr) franchisesUpdated++;
  }

  // --- 2. Constructor standings, per league + season ---
  const byLeagueSeasonFranchise = new Map<string, ResultRow[]>();
  for (const r of results ?? []) {
    if (!r.franchise_id) continue;
    const key = `${r.league_id}::${r.season}::${r.franchise_id}`;
    if (!byLeagueSeasonFranchise.has(key)) byLeagueSeasonFranchise.set(key, []);
    byLeagueSeasonFranchise.get(key)!.push(r);
  }

  let standingsUpserted = 0;
  for (const [key, rows] of byLeagueSeasonFranchise.entries()) {
    const [leagueId, season, franchiseId] = key.split("::");
    const classified = rows.filter((r) => !r.dnf && r.finish_position != null);

    const stats = {
      league_id: leagueId,
      season,
      franchise_id: franchiseId,
      starts: rows.length,
      wins: classified.filter((r) => r.finish_position === 1).length,
      top3: classified.filter((r) => (r.finish_position as number) <= 3).length,
      top5: classified.filter((r) => (r.finish_position as number) <= 5).length,
      top10: classified.filter((r) => (r.finish_position as number) <= 10).length,
      poles: rows.filter((r) => r.qualifying_position === 1).length,
      fastest_laps: rows.filter((r) => r.fastest_lap).length,
      dnfs: rows.filter((r) => r.dnf).length,
      points: rows.reduce((sum, r) => sum + (r.points_earned ?? 0), 0),
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .schema("pitboss")
      .from("constructor_standings")
      .upsert(stats, { onConflict: "league_id,season,franchise_id" });

    if (!upsertErr) standingsUpserted++;
  }

  return NextResponse.json({
    resultsScanned: results?.length ?? 0,
    franchisesUpdated,
    standingsUpserted,
  });
}
