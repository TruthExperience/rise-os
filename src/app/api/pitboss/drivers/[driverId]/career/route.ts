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

// Uses req.url/searchParams, which opts this route out of static
// optimization already — force-dynamic added anyway for clarity given
// the earlier Data Cache bug on the CFB roster/rulebook routes.
export const dynamic = "force-dynamic";

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
  round_id: string | null;
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

function summarize(results: ResultRow[], sprintRoundIds: Set<string>) {
  const isSprint = (r: ResultRow) => r.round_id != null && sprintRoundIds.has(r.round_id);
  const classified = results.filter((r) => !r.dnf && r.finish_position != null);
  const feature = classified.filter((r) => !isSprint(r));
  const sprint = classified.filter((r) => isSprint(r));
  const featureQuali = results.filter((r) => !isSprint(r));
  const sprintQuali = results.filter((r) => isSprint(r));

  return {
    starts: results.length,
    wins: feature.filter((r) => r.finish_position === 1).length,
    top3: feature.filter((r) => (r.finish_position as number) <= 3).length,
    top5: feature.filter((r) => (r.finish_position as number) <= 5).length,
    top10: feature.filter((r) => (r.finish_position as number) <= 10).length,
    poles: featureQuali.filter((r) => r.qualifying_position === 1).length,
    sprintWins: sprint.filter((r) => r.finish_position === 1).length,
    sprintPoles: sprintQuali.filter((r) => r.qualifying_position === 1).length,
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
      `
      id, league_id, franchise_id, season, round, track,
      finish_position, qualifying_position, dnf, fastest_lap, points_earned,
      round_id
      `
    )
    .eq("driver_id", driverId)
    .order("season", { ascending: false })
    .order("round", { ascending: false });

  if (leagueId) query = query.eq("league_id", leagueId);

  const { data: results, error } = await query.returns<ResultRow[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // results.round_id has no FK to rise_os.calendar_rounds (different schema,
  // no constraint), so PostgREST can't embed it — fetch separately instead,
  // same pattern as the franchises lookup below.
  const roundIds = Array.from(
    new Set((results ?? []).map((r) => r.round_id).filter(Boolean))
  ) as string[];

  let sprintRoundIds = new Set<string>();
  if (roundIds.length > 0) {
    const { data: rounds, error: roundErr } = await supabase
      .schema("rise_os")
      .from("calendar_rounds")
      .select("id, is_sprint")
      .in("id", roundIds);

    if (roundErr) {
      return NextResponse.json({ error: roundErr.message }, { status: 500 });
    }
    sprintRoundIds = new Set(
      (rounds ?? []).filter((r) => r.is_sprint === true).map((r) => r.id as string)
    );
  }

  // Driver identity + PP — needed for the profile header/stat grid.
  const { data: driver, error: driverErr } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select(
      "id, display_name, discord_username, discord_avatar, tier, super_licence_status, clean_race_streak, pp_total, created_at"
    )
    .eq("id", driverId)
    .single();

  if (driverErr || !driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  // Current active contract, scoped to league_id if provided.
  let currentTeamQuery = supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select("franchise:franchise_id ( id, name, abbreviation, logo_url )")
    .eq("driver_id", driverId)
    .eq("status", "active");

  if (leagueId) currentTeamQuery = currentTeamQuery.eq("league_id", leagueId);

  const { data: currentContract } = await currentTeamQuery
    .order("season_start", { ascending: false })
    .limit(1)
    .maybeSingle();

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

  const career = summarize(results ?? [], sprintRoundIds);

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
      stats: summarize(rows, sprintRoundIds),
    };
  });

  teams.sort((a, b) => {
    const aMax = Math.max(...byFranchise.get(a.franchiseId ?? "unknown")!.map((r) => Number(r.season) || 0));
    const bMax = Math.max(...byFranchise.get(b.franchiseId ?? "unknown")!.map((r) => Number(r.season) || 0));
    return bMax - aMax;
  });

  return NextResponse.json(
    {
      driverId,
      driver,
      currentTeam: currentContract?.franchise ?? null,
      career: { ...career, ppTotal: driver.pp_total ?? 0 },
      teams,
      recentResults: (results ?? []).slice(0, 10),
    },
    { headers: { "Cache-Control": "no-store, must-revalidate" } }
  );
}
