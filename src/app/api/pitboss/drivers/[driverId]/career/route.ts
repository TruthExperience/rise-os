import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// FIX: was process.env.SUPABASE_URL, which isn't set anywhere in this
// project's Vercel env vars (every other route uses NEXT_PUBLIC_SUPABASE_URL).
// That made this client undefined at build time, which crashed
// "Collecting page data" for this route and failed the production build
// for every deploy since this file was added.
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

type ResultRow = {
  id: string;
  league_id: string;
  franchise_id: string | null;
  season: string;
  round: number;
  track: string | null;
  finish_position: number | null;
  qualifying_position: number | null;
  dnf: boolean | null;
  fastest_lap: boolean | null;
  points_earned: number | null;
};

type Franchise = {
  id: string;
  name: string;
  abbreviation: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  race_starts: number | null;
  race_wins: number | null;
  race_top3: number | null;
  race_top5: number | null;
  race_top10: number | null;
};

function summarize(results: ResultRow[]) {
  const classified = results.filter((r) => !r.dnf && r.finish_position != null);
  return {
    starts: results.length,
    wins: classified.filter((r) => r.finish_position === 1).length,
    top3: classified.filter((r) => (r.finish_position as number) <= 3).length,
    top5: classified.filter((r) => (r.finish_position as number) <= 5).length,
    top10: classified.filter((r) => (r.finish_position as number) <= 10).length,
    poles: results.filter((r) => r.qualifying_position === 1).length,
    fastestLaps: results.filter((r) => r.fastest_lap).length,
    dnfs: results.filter((r) => r.dnf).length,
    points: results.reduce((sum, r) => sum + (r.points_earned ?? 0), 0),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { driverId: string } }
) {
  const supabase = getSupabase();
  const driverId = params.driverId;
  const { searchParams } = new URL(req.url);
  const leagueId = searchParams.get("league_id"); // optional filter

  let query = supabase
    .schema('pitboss')
    .from("results")
    .select(
      "id, league_id, franchise_id, season, round, track, finish_position, qualifying_position, dnf, fastest_lap, points_earned"
    )
    .eq("driver_id", driverId)
    .order("season", { ascending: false })
    .order("round", { ascending: false });

  if (leagueId) query = query.eq("league_id", leagueId);

  const { data: results, error } = await query.returns<ResultRow[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const franchiseIds = Array.from(
    new Set((results ?? []).map((r) => r.franchise_id).filter(Boolean))
  ) as string[];

  let franchises: Franchise[] = [];
  if (franchiseIds.length > 0) {
    const { data, error: fErr } = await supabase
      .schema('rise_os')
      .from("franchises")
      .select(
        "id, name, abbreviation, logo_url, primary_color, secondary_color, race_starts, race_wins, race_top3, race_top5, race_top10"
      )
      .in("id", franchiseIds);

    if (fErr) {
      return NextResponse.json({ error: fErr.message }, { status: 500 });
    }
    franchises = data ?? [];
  }
  const franchiseById = new Map(franchises.map((f) => [f.id, f]));

  const career = summarize(results ?? []);

  const byFranchise = new Map<string, ResultRow[]>();
  for (const r of results ?? []) {
    const key = r.franchise_id ?? "unknown";
    if (!byFranchise.has(key)) byFranchise.set(key, []);
    byFranchise.get(key)!.push(r);
  }

  const teams = Array.from(byFranchise.entries()).map(([franchiseId, rows]) => {
    const franchise = franchiseById.get(franchiseId) ?? null;
    const seasons = rows.map((r) => r.season).sort();
    return {
      franchiseId: franchiseId === "unknown" ? null : franchiseId,
      franchise,
      seasonRange:
        seasons.length > 0
          ? seasons[0] === seasons[seasons.length - 1]
            ? seasons[0]
            : `${seasons[0]}–${seasons[seasons.length - 1]}`
          : null,
      stats: summarize(rows),
    };
  });

  teams.sort((a, b) => {
    const aMax = Math.max(...byFranchise.get(a.franchiseId ?? "unknown")!.map((r) => Number(r.season) || 0));
    const bMax = Math.max(...byFranchise.get(b.franchiseId ?? "unknown")!.map((r) => Number(r.season) || 0));
    return bMax - aMax;
  });

  return NextResponse.json({
    driverId,
    career,
    teams,
    recentResults: (results ?? []).slice(0, 10),
  });
}
