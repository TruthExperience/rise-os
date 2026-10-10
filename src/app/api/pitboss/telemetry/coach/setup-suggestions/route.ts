// src/app/api/pitboss/telemetry/coach/setup-suggestions/route.ts
//
// GET /api/pitboss/telemetry/coach/setup-suggestions?session_uid=...&lap=N
//
// Suggests setup changes for one imported lap by comparing its setup against
// faster laps already in the database for the same track, car class, session
// type and conditions. The suggestion for each parameter is "move toward what
// the faster laps ran": the median of their values, snapped to the parameter's
// step and clamped to its legal range. A change is only offered when most of
// the faster laps sit on the same side of this lap's value.
//
// This is evidence from other laps, not a physics model, so setup differences
// can also reflect driving style. The UI says so.
//
// Setup values come from pitboss.setup_submissions.setup_values, which the
// telemetry-ingest route already maps onto param_key names, so no raw_payload
// is read here (it is 1MB+ per lap).
//
// Privacy: benchmark laps can belong to other drivers. Only per-parameter
// medians and counts leave this route, and a benchmark made up of a single
// other driver's laps is refused so it cannot reveal that driver's setup.

import { NextRequest, NextResponse } from "next/server";
import { getAuthedDriver, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MIN_BENCHMARK_LAPS = 3;
const MAX_BENCHMARK_LAPS = 10;
const MIN_GAP_SECONDS = 0.1; // benchmark laps must be at least this much faster
const MIN_AGREEMENT = 2 / 3; // share of benchmark laps on the suggested side
const MAX_SUGGESTIONS = 6;

type Status = "ok" | "insufficient_data" | "lap_invalid" | "no_setup";

interface RangeRow {
  min: number;
  max: number;
  step: number;
}

interface Suggestion {
  paramKey: string;
  label: string;
  current: number;
  suggested: number;
  direction: "increase" | "decrease";
  supportCount: number;
  benchmarkCount: number;
}

const TOKEN_LABELS: Record<string, string> = {
  arb: "ARB", drs: "DRS", ers: "ERS", ddv: "DDV",
};

function humanize(paramKey: string): string {
  const words = paramKey.split("_").map((w) => TOKEN_LABELS[w] ?? w);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(6, s.length - dot - 1);
}

function snap(value: number, step: number): number {
  return Number(value.toFixed(decimalsOf(step)));
}

function buildSuggestions(
  current: Record<string, number>,
  benchmarks: Record<string, number>[],
  ranges: Record<string, RangeRow>,
): Suggestion[] {
  const out: (Suggestion & { score: number; agreement: number })[] = [];

  for (const [paramKey, cur] of Object.entries(current)) {
    const range = ranges[paramKey];
    if (!range || typeof cur !== "number" || Number.isNaN(cur)) continue;

    const values = benchmarks
      .map((b) => b[paramKey])
      .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    if (values.length < MIN_BENCHMARK_LAPS) continue;

    const steps = Math.round((median(values) - cur) / range.step);
    if (steps === 0) continue;

    const target = Math.min(range.max, Math.max(range.min, cur + steps * range.step));
    const suggested = snap(target, range.step);
    if (suggested === snap(cur, range.step)) continue;

    const increase = suggested > cur;
    const half = range.step / 2;
    const support = values.filter((v) => (increase ? v - cur >= half : cur - v >= half)).length;
    const agreement = support / values.length;
    if (agreement < MIN_AGREEMENT) continue;

    const span = range.max - range.min || 1;
    out.push({
      paramKey,
      label: humanize(paramKey),
      current: cur,
      suggested,
      direction: increase ? "increase" : "decrease",
      supportCount: support,
      benchmarkCount: values.length,
      agreement,
      score: Math.abs(suggested - cur) / span,
    });
  }

  out.sort((a, b) => b.agreement - a.agreement || b.score - a.score);
  return out.slice(0, MAX_SUGGESTIONS).map(({ agreement: _a, score: _s, ...s }) => s);
}

function respond(status: Status, extra: Partial<{ benchmarkLaps: number; medianGapSeconds: number | null; suggestions: Suggestion[] }> = {}) {
  return NextResponse.json({
    status,
    minRequired: MIN_BENCHMARK_LAPS,
    benchmarkLaps: extra.benchmarkLaps ?? 0,
    medianGapSeconds: extra.medianGapSeconds ?? null,
    suggestions: extra.suggestions ?? [],
  });
}

export async function GET(req: NextRequest) {
  const requester = await getAuthedDriver();
  if (!requester) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sessionUid = req.nextUrl.searchParams.get("session_uid");
  const lap = Number(req.nextUrl.searchParams.get("lap"));
  if (!sessionUid || !Number.isInteger(lap) || lap < 0) {
    return NextResponse.json({ error: "session_uid and lap are required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: upload, error: uploadErr } = await admin
    .schema("pitboss")
    .from("setup_telemetry_uploads")
    .select(
      "id, driver_id, track_id, car_class_id, lap_time_seconds, lap_valid, session_type, submission_id, setup_submissions(league_id, conditions, setup_values)",
    )
    .eq("session_uid", sessionUid)
    .eq("lap_num", lap)
    .limit(1)
    .maybeSingle();

  if (uploadErr) {
    console.error("[pitboss/telemetry/coach/setup-suggestions] lap lookup failed", uploadErr);
    return NextResponse.json({ error: "failed to load lap" }, { status: 500 });
  }
  if (!upload) {
    return NextResponse.json({ error: "lap not found" }, { status: 404 });
  }

  const row = upload as any;
  const submission = row.setup_submissions;

  // Same access rule as the telemetry GET route: the lap's driver, or a steward
  // in the league its submission belongs to.
  if (row.driver_id !== requester.id) {
    const leagueId = submission?.league_id ?? null;
    let isSteward = false;
    if (leagueId) {
      const { data: membership } = await admin
        .schema("pitboss")
        .from("driver_leagues")
        .select("is_steward, is_head_steward")
        .eq("driver_id", requester.id)
        .eq("league_id", leagueId)
        .maybeSingle();
      isSteward = !!(membership?.is_steward || membership?.is_head_steward);
    }
    if (!isSteward) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  if (!row.lap_valid) return respond("lap_invalid");

  const lapTime = Number(row.lap_time_seconds);
  const current = submission?.setup_values as Record<string, number> | undefined;
  if (!current || !row.track_id || !row.car_class_id || !row.session_type || !Number.isFinite(lapTime)) {
    return respond("no_setup");
  }

  const { data: poolData, error: poolErr } = await admin
    .schema("pitboss")
    .from("setup_telemetry_uploads")
    .select("driver_id, lap_time_seconds, setup_submissions!inner(setup_values, conditions)")
    .eq("track_id", row.track_id)
    .eq("car_class_id", row.car_class_id)
    .eq("session_type", row.session_type)
    .eq("lap_valid", true)
    .eq("setup_submissions.conditions", submission.conditions)
    .lt("lap_time_seconds", lapTime - MIN_GAP_SECONDS)
    .order("lap_time_seconds", { ascending: true })
    .limit(MAX_BENCHMARK_LAPS);

  if (poolErr) {
    console.error("[pitboss/telemetry/coach/setup-suggestions] benchmark lookup failed", poolErr);
    return NextResponse.json({ error: "failed to load benchmark laps" }, { status: 500 });
  }

  const pool = ((poolData ?? []) as any[]).filter((r) => r.setup_submissions?.setup_values);
  if (pool.length < MIN_BENCHMARK_LAPS) {
    return respond("insufficient_data", { benchmarkLaps: pool.length });
  }

  // A benchmark made only of one other driver's laps would hand back that
  // driver's setup. Allow it only when it is the requester's own laps.
  const drivers = new Set(pool.map((r) => r.driver_id as string));
  if (drivers.size === 1 && !drivers.has(row.driver_id)) {
    return respond("insufficient_data", { benchmarkLaps: pool.length });
  }

  const { data: rangeRows, error: rangeErr } = await admin
    .schema("pitboss")
    .from("setup_parameter_ranges")
    .select("param_key, min_value, max_value, step, applicable_session_types")
    .eq("car_class_id", row.car_class_id);

  if (rangeErr) {
    console.error("[pitboss/telemetry/coach/setup-suggestions] range lookup failed", rangeErr);
    return NextResponse.json({ error: "failed to load parameter ranges" }, { status: 500 });
  }

  // Prefer the range row that applies to this session type; fall back to any.
  const ranges: Record<string, RangeRow> = {};
  const matched = new Set<string>();
  for (const r of (rangeRows ?? []) as any[]) {
    const min = Number(r.min_value);
    const max = Number(r.max_value);
    const step = Number(r.step) > 0 ? Number(r.step) : 1;
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const types = r.applicable_session_types;
    const applies = !Array.isArray(types) || types.length === 0 || types.includes(row.session_type);
    if (applies) {
      ranges[r.param_key] = { min, max, step };
      matched.add(r.param_key);
    } else if (!matched.has(r.param_key) && !(r.param_key in ranges)) {
      ranges[r.param_key] = { min, max, step };
    }
  }

  const suggestions = buildSuggestions(
    current,
    pool.map((r) => r.setup_submissions.setup_values as Record<string, number>),
    ranges,
  );

  const gaps = pool.map((r) => lapTime - Number(r.lap_time_seconds)).filter((g) => Number.isFinite(g));
  return respond("ok", {
    benchmarkLaps: pool.length,
    medianGapSeconds: gaps.length ? Number(median(gaps).toFixed(3)) : null,
    suggestions,
  });
}
