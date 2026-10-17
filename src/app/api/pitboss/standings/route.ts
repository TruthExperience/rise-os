import { NextRequest, NextResponse } from "next/server";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Any signed-in account may read standings (email sign-ups included).
  const userId = await getSupabaseUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const leagueId = req.nextUrl.searchParams.get("league_id");
  const requestedSeason = req.nextUrl.searchParams.get("season");

  if (!leagueId) {
    return NextResponse.json({ error: "league_id is required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: league, error: leagueError } = await supabase
    .schema("pitboss")
    .from("leagues")
    .select("name, logo_url")
    .eq("id", leagueId)
    .single();

  if (leagueError || !league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }

  // Seasons that have standings for this league. When the caller doesn't
  // name a season (or asks for "latest"), show the highest one.
  const { data: seasonRows } = await supabase
    .schema("pitboss")
    .from("driver_standings")
    .select("season")
    .eq("league_id", leagueId);
  const seasons = Array.from(new Set((seasonRows ?? []).map((r) => String(r.season)))).sort(
    (a, b) => Number(b) - Number(a) || b.localeCompare(a)
  );
  const season =
    requestedSeason && requestedSeason !== "latest" ? requestedSeason : seasons[0] ?? "";

  if (!season) {
    return NextResponse.json({
      league_name: league.name,
      league_logo_url: league.logo_url,
      season: "",
      seasons: [],
      standings: [],
      teams: [],
    });
  }

  const { data, error } = await supabase
    .schema("pitboss")
    .from("driver_standings")
    .select(
      "driver_id, starts, wins, top3, top5, top10, poles, fastest_laps, dnfs, sprint_wins, sprint_fastest_laps, points, drivers(discord_username, display_name)"
    )
    .eq("league_id", leagueId)
    .eq("season", season)
    .order("points", { ascending: false });

  if (error) {
    return NextResponse.json({ error: `Failed to load standings: ${error.message}` }, { status: 500 });
  }

  const standings = data.map((row, i) => {
    const driver = row.drivers as unknown as { discord_username: string; display_name: string | null } | null;
    return {
      position: i + 1,
      driver_id: row.driver_id,
      driver_name: driver?.display_name ?? driver?.discord_username ?? "Unknown",
      starts: row.starts,
      wins: row.wins,
      top3: row.top3,
      top5: row.top5,
      top10: row.top10,
      poles: row.poles,
      fastest_laps: row.fastest_laps,
      dnfs: row.dnfs,
      sprint_wins: row.sprint_wins,
      sprint_fastest_laps: row.sprint_fastest_laps,
      points: row.points,
    };
  });

  // Team (constructor) standings for the same season. Franchise names live in
  // another schema, so this is two queries merged in memory.
  const { data: teamRows } = await supabase
    .schema("pitboss")
    .from("constructor_standings")
    .select("franchise_id, starts, wins, top3, poles, fastest_laps, dnfs, points")
    .eq("league_id", leagueId)
    .eq("season", season)
    .order("points", { ascending: false });

  const franchiseIds = (teamRows ?? []).map((t) => t.franchise_id);
  const franchiseMap: Record<string, { name: string; abbreviation: string | null; logo_url: string | null; primary_color: string | null }> = {};
  if (franchiseIds.length > 0) {
    const { data: franchises } = await supabase
      .schema("rise_os")
      .from("franchises")
      .select("id, name, abbreviation, logo_url, primary_color")
      .in("id", franchiseIds);
    for (const f of franchises ?? []) franchiseMap[f.id] = f;
  }
  const teams = (teamRows ?? []).map((t, i) => ({
    position: i + 1,
    franchise_id: t.franchise_id,
    team_name: franchiseMap[t.franchise_id]?.name ?? "Unknown team",
    abbreviation: franchiseMap[t.franchise_id]?.abbreviation ?? null,
    logo_url: franchiseMap[t.franchise_id]?.logo_url ?? null,
    color: franchiseMap[t.franchise_id]?.primary_color ?? null,
    starts: t.starts,
    wins: t.wins,
    top3: t.top3,
    poles: t.poles,
    fastest_laps: t.fastest_laps,
    dnfs: t.dnfs,
    points: t.points,
  }));

  return NextResponse.json({
    league_name: league.name,
    league_logo_url: league.logo_url,
    season,
    seasons,
    standings,
    teams,
  });
}
