// FILE: src/lib/pitboss/standings-through.ts   (new file)
// Championship standings as they stood after a given round. Same rules as the
// driver_standings_live / constructor_standings_live views (points include
// sprint points, wins/podiums/top5/top10 ignore DNFs, round 0 is excluded),
// but limited to rounds <= upTo so a Discord card for round N keeps showing
// round N even after later rounds are entered.
// Driver adjustments carry no round, so only those created before the first
// result of round upTo+1 are counted (all of them for the latest round).

type Agg = {
  wins: number; top3: number; top5: number; top10: number;
  poles: number; fastest_laps: number; dnfs: number; points: number;
};
const blank = (): Agg => ({ wins: 0, top3: 0, top5: 0, top10: 0, poles: 0, fastest_laps: 0, dnfs: 0, points: 0 });

export async function standingsThrough(
  pb: any,
  leagueId: string,
  season: string,
  upTo: number,
  by: "driver" | "team"
): Promise<{ rows: any[]; raw: any[] }> {
  const { data: rawAll } = await pb
    .from("results_with_team")
    .select(
      "driver_id, team_id, round, finish_position, qualifying_position, dnf, fastest_lap, points_earned, sprint_points_earned"
    )
    .eq("league_id", leagueId)
    .eq("season", season)
    .lte("round", upTo)
    .limit(10000);
  const raw = (rawAll ?? []).filter((r: any) => Number(r.round) !== 0);

  const map = new Map<string, Agg>();
  for (const r of raw) {
    const id = by === "driver" ? r.driver_id : r.team_id;
    if (!id) continue;
    const a = map.get(id) ?? blank();
    const fin = r.dnf !== true ? r.finish_position : null;
    if (fin != null && fin === 1) a.wins++;
    if (fin != null && fin <= 3) a.top3++;
    if (fin != null && fin <= 5) a.top5++;
    if (fin != null && fin <= 10) a.top10++;
    if (r.qualifying_position === 1) a.poles++;
    if (r.fastest_lap === true) a.fastest_laps++;
    if (r.dnf === true) a.dnfs++;
    a.points += Number(r.points_earned ?? 0) + Number(r.sprint_points_earned ?? 0);
    map.set(id, a);
  }

  if (by === "driver") {
    const { data: nxt } = await pb
      .from("results")
      .select("created_at")
      .eq("league_id", leagueId)
      .eq("season", season)
      .gt("round", upTo)
      .order("created_at", { ascending: true })
      .limit(1);
    let q = pb
      .from("standings_adjustments")
      .select("driver_id, points_delta, created_at")
      .eq("league_id", leagueId)
      .eq("season", season);
    if (nxt?.[0]?.created_at) q = q.lt("created_at", nxt[0].created_at);
    const { data: adj } = await q;
    for (const j of adj ?? []) {
      const a = map.get(j.driver_id) ?? blank();
      a.points += Number(j.points_delta ?? 0);
      map.set(j.driver_id, a);
    }
  }

  const rows = [...map.entries()].map(([id, a]) =>
    by === "driver" ? { driver_id: id, ...a } : { franchise_id: id, ...a }
  );
  return { rows, raw };
}
