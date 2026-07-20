import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const leagueId = req.nextUrl.searchParams.get("league_id");
  const season = req.nextUrl.searchParams.get("season");

  if (!leagueId || !season) {
    return NextResponse.json({ error: "league_id and season are required" }, { status: 400 });
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

  return NextResponse.json({
    league_name: league.name,
    league_logo_url: league.logo_url,
    standings,
  });
}
