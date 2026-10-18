// FILE: src/lib/pitboss/driver-stats.ts   (new file)
// Extended per-driver championship stats (P1/P2/P3, best/worst/avg finish and
// quali, avg gain, rounds led, avg points, scoring %, gap/interval, latest gain).
// Computed from raw results rows; DNFs are left out of finish-position stats.

export type StatResult = {
  driver_id: string;
  round: number;
  finish_position: number | null;
  qualifying_position: number | null;
  dnf: boolean | null;
  points_earned: number | null;
  sprint_points_earned: number | null;
};

export type ExtraStats = {
  p1: number; p2: number; p3: number;
  best_r: number | null; worst_r: number | null; avg_r: number | null;
  best_q: number | null; worst_q: number | null; avg_q: number | null;
  avg_gain: number | null;
  rds_led: number;
  avg_pts: number;
  scr_pct: number;
  events: number;
  gain: number;
  gap: number;
  interval: number;
};

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

export function computeExtraStats(results: StatResult[]): Record<string, ExtraStats> {
  const pts = (r: StatResult) => Number(r.points_earned ?? 0) + Number(r.sprint_points_earned ?? 0);
  const byDriver = new Map<string, StatResult[]>();
  for (const r of results) {
    if (!byDriver.has(r.driver_id)) byDriver.set(r.driver_id, []);
    byDriver.get(r.driver_id)!.push(r);
  }
  const rounds = [...new Set(results.map((r) => r.round))].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1];

  // Championship leader after each round (points, then wins, then podiums).
  const cum = new Map<string, { pts: number; wins: number; top3: number }>();
  const led = new Map<string, number>();
  for (const rd of rounds) {
    for (const r of results.filter((x) => x.round === rd)) {
      const c = cum.get(r.driver_id) ?? { pts: 0, wins: 0, top3: 0 };
      c.pts += pts(r);
      if (!r.dnf && r.finish_position === 1) c.wins++;
      if (!r.dnf && r.finish_position != null && r.finish_position <= 3) c.top3++;
      cum.set(r.driver_id, c);
    }
    const lead = [...cum.entries()].sort(
      (a, b) => b[1].pts - a[1].pts || b[1].wins - a[1].wins || b[1].top3 - a[1].top3
    )[0];
    if (lead) led.set(lead[0], (led.get(lead[0]) ?? 0) + 1);
  }

  const out: Record<string, ExtraStats> = {};
  const totals: { id: string; pts: number }[] = [];
  for (const [id, rs] of byDriver) {
    const fin = rs.filter((r) => !r.dnf && r.finish_position != null).map((r) => r.finish_position!);
    const q = rs.filter((r) => r.qualifying_position != null).map((r) => r.qualifying_position!);
    const total = rs.reduce((s, r) => s + pts(r), 0);
    const scored = rs.filter((r) => pts(r) > 0).length;
    const aR = avg(fin);
    const aQ = avg(q);
    totals.push({ id, pts: total });
    out[id] = {
      p1: fin.filter((p) => p === 1).length,
      p2: fin.filter((p) => p === 2).length,
      p3: fin.filter((p) => p === 3).length,
      best_r: fin.length ? Math.min(...fin) : null,
      worst_r: fin.length ? Math.max(...fin) : null,
      avg_r: r1(aR),
      best_q: q.length ? Math.min(...q) : null,
      worst_q: q.length ? Math.max(...q) : null,
      avg_q: r1(aQ),
      avg_gain: aR != null && aQ != null ? r1(aQ - aR) : null,
      rds_led: led.get(id) ?? 0,
      avg_pts: r1(rs.length ? total / rs.length : 0)!,
      scr_pct: Math.round((rs.length ? (scored / rs.length) * 1000 : 0)) / 10,
      events: rs.length,
      gain: rs.filter((r) => r.round === lastRound).reduce((s, r) => s + pts(r), 0),
      gap: 0,
      interval: 0,
    };
  }
  totals.sort((a, b) => b.pts - a.pts);
  totals.forEach((t, i) => {
    out[t.id].gap = totals[0].pts - t.pts;
    out[t.id].interval = i === 0 ? 0 : totals[i - 1].pts - t.pts;
  });
  return out;
}
