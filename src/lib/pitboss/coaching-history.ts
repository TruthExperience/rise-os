/**
 * PitBoss — Coaching History & Trends
 * ------------------------------------
 * Persistence + aggregation layer sitting on top of telemetry-coach.ts.
 * telemetry-coach.ts computes a single lap's CoachingReport; this file:
 *
 *   1. Caches every generated CoachingReport in pitboss.coaching_reports
 *      (the "static" fast path — a repeat request for the same lap/
 *      reference-lap pair is served from cache instead of re-running
 *      corner detection + a fresh LLM narrative call).
 *   2. Distills each report into issues_summary/corner_summary at write
 *      time, so the trends query below can aggregate cheaply over many
 *      laps without unpacking full_report JSON for each one.
 *   3. Aggregates those distilled rows into a season-long trend view per
 *      driver (optionally scoped to one track) — the "dynamic"/ongoing
 *      coaching profile: is a given corner's minimum speed trending up,
 *      is a given issue kind becoming less frequent, etc.
 *
 * SERVER-ONLY — same reason as telemetry-coach.ts (this imports
 * createAdminClient). Never import from a 'use client' component.
 */

import { createAdminClient } from '@/lib/supabase/server';
import type { CoachingReport } from './telemetry-coach-types';
import type { IssueKind } from './telemetry-coach-types';

const ISSUE_KINDS: IssueKind[] = ['lockup', 'snap_correction', 'off_track_suspected', 'engine_over_rev'];

function summarizeIssues(report: CoachingReport): Record<IssueKind, number> {
  const counts = Object.fromEntries(ISSUE_KINDS.map((k) => [k, 0])) as Record<IssueKind, number>;
  // General (non-corner-specific) issues, plus every corner's own issues —
  // a lockup detected mid-corner is still a lockup for frequency-tracking
  // purposes, whether or not it's also shown attached to that corner in
  // the UI.
  for (const issue of report.issues) counts[issue.kind]++;
  for (const corner of report.corners) {
    for (const issue of corner.issues) counts[issue.kind]++;
  }
  return counts;
}

interface CornerSummaryEntry {
  corner_id: number;
  direction: 'left' | 'right';
  min_speed_in_corner: number;
  brake_point_dist: number;
  trail_brake_percent: number;
  application_smoothness: number;
}

function summarizeCorners(report: CoachingReport): CornerSummaryEntry[] {
  return report.corners.map((c) => ({
    corner_id: c.corner.id,
    direction: c.corner.direction,
    min_speed_in_corner: c.braking.minSpeedInCorner,
    brake_point_dist: c.braking.brakePointDist,
    trail_brake_percent: c.braking.trailBrakePercent,
    application_smoothness: c.throttle.applicationSmoothness,
  }));
}

export interface PersistCoachingReportParams {
  driverId: string;
  trackId: string | null;
  carClassId: string | null;
  sessionUid: string;
  lapNum: number;
  referenceLapNum: number | null;
  lapTimeSeconds: number | null;
  lapValid: boolean;
  report: CoachingReport;
}

/**
 * Upserts the cache/trend row for one lap's coaching report. Best-effort
 * by design — callers (telemetry-ingest's dynamic path, the on-demand
 * coach GET route) should wrap this in try/catch and never let a
 * persistence failure block the actual report from reaching the caller.
 */
export async function persistCoachingReport(params: PersistCoachingReportParams): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .schema('pitboss')
    .from('coaching_reports')
    .upsert(
      {
        driver_id: params.driverId,
        track_id: params.trackId,
        car_class_id: params.carClassId,
        session_uid: params.sessionUid,
        lap_num: params.lapNum,
        reference_lap_num: params.referenceLapNum,
        lap_time_seconds: params.lapTimeSeconds,
        lap_valid: params.lapValid,
        issues_summary: summarizeIssues(params.report),
        corner_summary: summarizeCorners(params.report),
        narrative_source: params.report.narrativeSource,
        full_report: params.report,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'session_uid,lap_num' }
    );

  if (error) {
    throw new Error(`Failed to persist coaching report: ${error.message}`);
  }
}

/**
 * Returns a cached CoachingReport for this exact (session_uid, lap_num,
 * reference_lap_num) combination, or null if nothing's cached yet (or the
 * cached row was generated against a different reference lap than this
 * request wants). Callers fall back to a fresh buildCoachingReport() call
 * on a miss — this function performs no computation itself.
 */
export async function getCachedCoachingReport(
  sessionUid: string,
  lapNum: number,
  referenceLapNum: number | null
): Promise<CoachingReport | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema('pitboss')
    .from('coaching_reports')
    .select('reference_lap_num, full_report')
    .eq('session_uid', sessionUid)
    .eq('lap_num', lapNum)
    .maybeSingle();

  if (error) {
    console.error('[coaching-history] cache read failed:', error.message);
    return null;
  }
  if (!data) return null;
  if ((data.reference_lap_num ?? null) !== (referenceLapNum ?? null)) return null;

  return data.full_report as CoachingReport;
}

export interface CornerTrendPoint {
  cornerId: number;
  direction: 'left' | 'right';
  sampleCount: number;
  bestMinSpeed: number;
  worstMinSpeed: number;
  avgMinSpeed: number;
  // Population stddev of brake_point_dist across samples — a rough proxy
  // for braking-point consistency at this corner. Lower = more consistent
  // lap to lap. Requires at least 2 samples; null otherwise.
  brakePointStdDev: number | null;
  // Most recent sample's min speed minus the average of all *earlier*
  // samples — positive means the driver is carrying more speed through
  // this corner lately than their own history, negative means regressing.
  recentTrendDelta: number | null;
}

export interface IssueTrendPoint {
  kind: IssueKind;
  totalCount: number;
  // Count in the most recent half of the sampled laps vs the earlier
  // half — lets the UI show "up" / "down" / "flat" without the caller
  // needing to re-derive it from a raw time series.
  recentHalfCount: number;
  earlierHalfCount: number;
}

export interface DriverCoachingTrends {
  driverId: string;
  trackId: string | null;
  lapsAnalyzed: number;
  lapTimeTrend: { lapNum: number; sessionUid: string; lapTimeSeconds: number; generatedAt: string }[];
  corners: CornerTrendPoint[];
  issues: IssueTrendPoint[];
}

const DEFAULT_TREND_LAP_LIMIT = 100;

/**
 * Aggregates this driver's persisted coaching_reports rows into a
 * season-long trend view. Scoped to one track when trackId is given
 * (corner numbering/layout is only comparable within the same track);
 * omit trackId to get lap-time and issue trends across every track
 * instead (corner-level trends are always track-scoped and will be
 * empty in that case, since corner ids aren't comparable across tracks).
 */
export async function getDriverCoachingTrends(
  driverId: string,
  trackId: string | null = null,
  limit: number = DEFAULT_TREND_LAP_LIMIT
): Promise<DriverCoachingTrends> {
  const supabase = createAdminClient();
  let query = supabase
    .schema('pitboss')
    .from('coaching_reports')
    .select('session_uid, lap_num, track_id, lap_time_seconds, lap_valid, issues_summary, corner_summary, generated_at')
    .eq('driver_id', driverId)
    .eq('lap_valid', true)
    .order('generated_at', { ascending: true })
    .limit(limit);

  if (trackId) query = query.eq('track_id', trackId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load coaching trends: ${error.message}`);
  const rows = data ?? [];

  const lapTimeTrend = rows
    .filter((r) => r.lap_time_seconds != null)
    .map((r) => ({
      lapNum: r.lap_num,
      sessionUid: r.session_uid,
      lapTimeSeconds: Number(r.lap_time_seconds),
      generatedAt: r.generated_at,
    }));

  // Issue trend — sum issues_summary across rows, split into earlier/
  // recent halves by chronological position (rows are already ordered
  // ascending by generated_at from the query above).
  const issueTotals = Object.fromEntries(ISSUE_KINDS.map((k) => [k, { total: 0, recent: 0, earlier: 0 }])) as Record<
    IssueKind,
    { total: number; recent: number; earlier: number }
  >;
  const midpoint = Math.floor(rows.length / 2);
  rows.forEach((row, idx) => {
    const summary = (row.issues_summary ?? {}) as Partial<Record<IssueKind, number>>;
    for (const kind of ISSUE_KINDS) {
      const count = summary[kind] ?? 0;
      issueTotals[kind].total += count;
      if (idx < midpoint) issueTotals[kind].earlier += count;
      else issueTotals[kind].recent += count;
    }
  });
  const issues: IssueTrendPoint[] = ISSUE_KINDS.map((kind) => ({
    kind,
    totalCount: issueTotals[kind].total,
    recentHalfCount: issueTotals[kind].recent,
    earlierHalfCount: issueTotals[kind].earlier,
  }));

  // Corner trend — only meaningful when scoped to a single track (corner
  // ids from detectCorners() are positional per-lap, not globally stable
  // across different circuits).
  let corners: CornerTrendPoint[] = [];
  if (trackId) {
    const byCorner = new Map<number, { direction: 'left' | 'right'; minSpeeds: number[]; brakePoints: number[] }>();
    for (const row of rows) {
      const cornerSummary = (row.corner_summary ?? []) as CornerSummaryEntry[];
      for (const c of cornerSummary) {
        if (!byCorner.has(c.corner_id)) {
          byCorner.set(c.corner_id, { direction: c.direction, minSpeeds: [], brakePoints: [] });
        }
        const entry = byCorner.get(c.corner_id)!;
        entry.minSpeeds.push(c.min_speed_in_corner);
        entry.brakePoints.push(c.brake_point_dist);
      }
    }

    corners = Array.from(byCorner.entries())
      .map(([cornerId, entry]) => {
        const n = entry.minSpeeds.length;
        const avg = entry.minSpeeds.reduce((a, b) => a + b, 0) / n;
        let brakePointStdDev: number | null = null;
        if (n >= 2) {
          const bpMean = entry.brakePoints.reduce((a, b) => a + b, 0) / n;
          const variance = entry.brakePoints.reduce((sum, v) => sum + (v - bpMean) ** 2, 0) / n;
          brakePointStdDev = Math.sqrt(variance);
        }
        let recentTrendDelta: number | null = null;
        if (n >= 2) {
          const mostRecent = entry.minSpeeds[n - 1];
          const priorAvg = entry.minSpeeds.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1);
          recentTrendDelta = mostRecent - priorAvg;
        }
        return {
          cornerId,
          direction: entry.direction,
          sampleCount: n,
          bestMinSpeed: Math.max(...entry.minSpeeds),
          worstMinSpeed: Math.min(...entry.minSpeeds),
          avgMinSpeed: avg,
          brakePointStdDev,
          recentTrendDelta,
        };
      })
      .sort((a, b) => a.cornerId - b.cornerId);
  }

  return {
    driverId,
    trackId,
    lapsAnalyzed: rows.length,
    lapTimeTrend,
    corners,
    issues,
  };
}
