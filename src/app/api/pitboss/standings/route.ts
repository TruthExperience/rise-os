// FILE: src/app/api/pitboss/standings/route.ts   (replace the whole file)
// Revamp: seasons + rosters seeded in driver_standings / constructor_standings now show at 0 pts before any results exist.
import { computeExtraStats } from "@/lib/pitboss/driver-stats";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// GET /api/pitboss/standings?league_id=&season=&view=drivers|teams
// Reads the *_live views, which are computed from pitboss.results on every
// request — a saved/edited/penalised result shows up on the next call.
export async function GET(req: NextRequest) {
  const userId = await getSupabaseUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }

  const leagueId = req.nextUrl.searchParams.get("league_id");
  let season = req.nextUrl.searchParams.get("season");
  // "latest" (or blank) means "newest season with results", not a literal season value.
  if (season === "latest" || season === "") season = null;
  const view = req.nextUrl.searchParams.get("view") === "teams" ? "teams" : "drivers";
  // Optional race switcher: standings as they stood after this round.
  const roundParam = req.nextUrl.searchParams.get("round");
  const throughRound = roundParam != null && roundParam !== "" ? Number(roundParam) : null;
  if (throughRound != null && !Number.isInteger(throughRound)) {
    return NextResponse.json({ error: "round must be a whole number" }, { status: 400, headers: NO_STORE });
  }

  if (!leagueId) {
    return NextResponse.json({ error: "league_id is required" }, { status: 400, headers: NO_STORE });
  }

  const supabase = createAdminClient();
  const pb = supabase.schema("pitboss");

  const { data: league, error: leagueError } = await pb
    .from("leagues")
    .select("name, logo_url")
    .eq("id", leagueId)
    .single();
  if (leagueError || !league) {
    return NextResponse.json({ error: "League not found" }, { status: 404, headers: NO_STORE });
  }

  // Seasons that have results, newest first; default to the latest one.
  const { data: seasonRows } = await pb
    .from("results_last_change")
    .select("season")
    .eq("league_id", leagueId);
  // Also count seasons that have only been seeded (0-point rows) in the base standings tables,
  // so a league shows its roster before the first result is saved.
  const { data: seededRows } = await pb
    .from("driver_standings")
    .select("season")
    .eq("league_id", leagueId);
  const seasons = [...new Set([...(seasonRows ?? []), ...(seededRows ?? [])].map((r: any) => String(r.season)))].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    return Number.isNaN(na) || Number.isNaN(nb) ? b.localeCompare(a) : nb - na;
  });
  if (!season) season = seasons[0] ?? null;

  const { data: change } = season
    ? await pb
        .from("results_last_change")
        .select("last_change, row_count")
        .eq("league_id", leagueId)
        .eq("season", season)
        .maybeSingle()
    : { data: null };
  const version = change ? `${change.row_count}:${change.last_change}` : "0";

  // Races in this season (for the race switcher).
  let rounds: { round: number; track: string | null }[] = [];
  if (season) {
    const { data: roundRows } = await pb
      .from("results")
      .select("round, track")
      .eq("league_id", leagueId)
      .eq("season", season)
      .limit(5000);
    const byRound = new Map<number, string | null>();
    for (const r of roundRows ?? []) {
      if (!byRound.has(r.round) || (!byRound.get(r.round) && r.track)) byRound.set(r.round, r.track ?? null);
    }
    rounds = [...byRound.entries()].map(([round, track]) => ({ round, track })).sort((a, b) => a.round - b.round);
  }

  const base = {
    league_name: league.name,
    league_logo_url: league.logo_url,
    season,
    seasons,
    rounds,
    through_round: throughRound,
    view,
    version,
  };

  if (!season) {
    return NextResponse.json({ ...base, standings: [] }, { headers: NO_STORE });
  }

  // "After round N": aggregate results up to that round on the fly. (Manual
  // /set-standings adjustments are season-level, so they apply only to the
  // full-season view.)
  type Agg = {
    starts: number; wins: number; top3: number; top5: number; top10: number;
    poles: number; fastest_laps: number; dnfs: number; sprint_wins: number;
    sprint_fastest_laps: number; points: number; drivers: Set<string>;
  };
  const blank = (): Agg => ({
    starts: 0, wins: 0, top3: 0, top5: 0, top10: 0, poles: 0, fastest_laps: 0,
    dnfs: 0, sprint_wins: 0, sprint_fastest_laps: 0, points: 0, drivers: new Set(),
  });
  let throughRows: Record<string, Agg> | null = null;
  if (throughRound != null) {
    const key = view === "teams" ? "team_id" : "driver_id";
    const { data: rs, error: rsErr } = await pb
      .from("results_with_team")
      .select("driver_id, team_id, finish_position, qualifying_position, dnf, fastest_lap, points_earned, sprint_finish_position, sprint_dnf, sprint_fastest_lap, sprint_points_earned")
      .eq("league_id", leagueId)
      .eq("season", season)
      .lte("round", throughRound)
      .limit(10000);
    if (rsErr) {
      return NextResponse.json({ error: `Failed to load standings: ${rsErr.message}` }, { status: 500, headers: NO_STORE });
    }
    throughRows = {};
    for (const r of rs ?? []) {
      const id = (r as any)[key];
      if (!id) continue;
      const a = (throughRows[id] ??= blank());
      a.starts++;
      if (!r.dnf && r.finish_position === 1) a.wins++;
      if (!r.dnf && r.finish_position != null && r.finish_position <= 3) a.top3++;
      if (!r.dnf && r.finish_position != null && r.finish_position <= 5) a.top5++;
      if (!r.dnf && r.finish_position != null && r.finish_position <= 10) a.top10++;
      if (r.qualifying_position === 1) a.poles++;
      if (r.fastest_lap) a.fastest_laps++;
      if (r.dnf) a.dnfs++;
      if (!r.sprint_dnf && r.sprint_finish_position === 1) a.sprint_wins++;
      if (r.sprint_fastest_lap) a.sprint_fastest_laps++;
      a.points += Number(r.points_earned ?? 0) + Number(r.sprint_points_earned ?? 0);
      a.drivers.add(r.driver_id);
    }
  }

  if (view === "teams") {
    const { data: liveData, error } = throughRows
      ? { data: null, error: null }
      : await pb
          .from("constructor_standings_live")
          .select("franchise_id, starts, wins, top3, poles, fastest_laps, dnfs, drivers, points")
          .eq("league_id", leagueId)
          .eq("season", season);
    const data: any[] | null = throughRows
      ? Object.entries(throughRows).map(([franchise_id, a]) => ({ franchise_id, ...a, drivers: a.drivers.size }))
      : liveData;
    if (error) {
      return NextResponse.json({ error: `Failed to load team standings: ${error.message}` }, { status: 500, headers: NO_STORE });
    }

    // Zero-fill teams seeded in constructor_standings that have no results yet.
    const { data: seededTeams } = await pb
      .from("constructor_standings")
      .select("franchise_id")
      .eq("league_id", leagueId)
      .eq("season", season);
    const haveTeam = new Set((data ?? []).map((r: any) => r.franchise_id));
    const teamData: any[] = [...(data ?? [])];
    for (const t of seededTeams ?? []) {
      if (!haveTeam.has(t.franchise_id)) {
        teamData.push({ franchise_id: t.franchise_id, starts: 0, wins: 0, top3: 0, poles: 0, fastest_laps: 0, dnfs: 0, drivers: 0, points: 0 });
      }
    }

    const ids = teamData.map((r: any) => r.franchise_id);
    const { data: teams } = ids.length
      ? await supabase
          .schema("rise_os")
          .from("franchises")
          .select("id, name, abbreviation, logo_url, primary_color")
          .in("id", ids)
      : { data: [] as any[] };
    const teamMap = Object.fromEntries((teams ?? []).map((t: any) => [t.id, t]));

    const rows = teamData
      .map((r: any) => ({ ...r, points: Number(r.points) }))
      .sort((a: any, b: any) => b.points - a.points || b.wins - a.wins || b.top3 - a.top3 || String(a.franchise_id).localeCompare(String(b.franchise_id)))
      .map((r: any, i: number) => {
        const t = teamMap[r.franchise_id];
        return {
          position: i + 1,
          franchise_id: r.franchise_id,
          team_name: t?.name ?? "Unknown team",
          abbreviation: t?.abbreviation ?? null,
          logo_url: t?.logo_url ?? null,
          color: t?.primary_color ?? null,
          drivers: r.drivers,
          starts: r.starts,
          wins: r.wins,
          top3: r.top3,
          poles: r.poles,
          fastest_laps: r.fastest_laps,
          dnfs: r.dnfs,
          points: r.points,
        };
      });
    return NextResponse.json({ ...base, standings: rows }, { headers: NO_STORE });
  }

  const { data: liveDrivers, error } = throughRows
    ? { data: null, error: null }
    : await pb
        .from("driver_standings_live")
        .select("driver_id, starts, wins, top3, top5, top10, poles, fastest_laps, dnfs, sprint_wins, sprint_fastest_laps, points")
        .eq("league_id", leagueId)
        .eq("season", season);
  const data: any[] | null = throughRows
    ? Object.entries(throughRows).map(([driver_id, a]) => ({ driver_id, ...a }))
    : liveDrivers;
  if (error) {
    return NextResponse.json({ error: `Failed to load standings: ${error.message}` }, { status: 500, headers: NO_STORE });
  }

  // Zero-fill drivers seeded in driver_standings that have no results yet.
  const { data: seededDrivers } = await pb
    .from("driver_standings")
    .select("driver_id")
    .eq("league_id", leagueId)
    .eq("season", season);
  const haveDriver = new Set((data ?? []).map((r: any) => r.driver_id));
  const driverData: any[] = [...(data ?? [])];
  for (const d of seededDrivers ?? []) {
    if (!haveDriver.has(d.driver_id)) {
      driverData.push({ driver_id: d.driver_id, starts: 0, wins: 0, top3: 0, top5: 0, top10: 0, poles: 0, fastest_laps: 0, dnfs: 0, sprint_wins: 0, sprint_fastest_laps: 0, points: 0 });
    }
  }

  const ids = driverData.map((r: any) => r.driver_id);
  const { data: drivers } = ids.length
    ? await pb.from("drivers").select("id, discord_username, display_name").in("id", ids)
    : { data: [] as any[] };
  const driverMap = Object.fromEntries((drivers ?? []).map((d: any) => [d.id, d]));

  let extra: Record<string, any> = {};
  {
    let q = pb
      .from("results_with_team")
      .select("driver_id, round, finish_position, qualifying_position, dnf, points_earned, sprint_points_earned")
      .eq("league_id", leagueId)
      .eq("season", season)
      .limit(10000);
    if (throughRound != null) q = q.lte("round", throughRound);
    const { data: raw } = await q;
    extra = computeExtraStats((raw ?? []) as any[]);
  }

  const rows = driverData
    .map((r: any) => ({ ...r, points: Number(r.points) }))
    .sort((a: any, b: any) =>
      b.points - a.points || b.wins - a.wins || b.top3 - a.top3 ||
      String(driverMap[a.driver_id]?.display_name ?? "").localeCompare(String(driverMap[b.driver_id]?.display_name ?? "")))
    .map((r: any, i: number) => ({
      position: i + 1,
      driver_id: r.driver_id,
      driver_name: driverMap[r.driver_id]?.display_name ?? driverMap[r.driver_id]?.discord_username ?? "Unknown",
      starts: r.starts,
      wins: r.wins,
      top3: r.top3,
      top5: r.top5,
      top10: r.top10,
      poles: r.poles,
      fastest_laps: r.fastest_laps,
      dnfs: r.dnfs,
      sprint_wins: r.sprint_wins,
      sprint_fastest_laps: r.sprint_fastest_laps,
      points: r.points,
      stats: extra[r.driver_id] ?? null,
    }));

  return NextResponse.json({ ...base, standings: rows }, { headers: NO_STORE });
}
