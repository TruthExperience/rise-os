"use client";

import React, { useEffect, useState } from "react";

// Mirrors the shape returned by DriverCoachingTrends in
// lib/pitboss/coaching-history.ts. Kept as a local type rather than
// importing that file directly — coaching-history.ts pulls in
// createAdminClient (server-only), same reason telemetry-coach-types.ts
// exists as a split-out client-safe file for CoachingPanel.tsx.
type IssueKind = "lockup" | "snap_correction" | "off_track_suspected" | "engine_over_rev";

interface CornerTrendPoint {
  cornerId: number;
  direction: "left" | "right";
  sampleCount: number;
  bestMinSpeed: number;
  worstMinSpeed: number;
  avgMinSpeed: number;
  brakePointStdDev: number | null;
  recentTrendDelta: number | null;
}

interface IssueTrendPoint {
  kind: IssueKind;
  totalCount: number;
  recentHalfCount: number;
  earlierHalfCount: number;
}

interface DriverCoachingTrends {
  driverId: string;
  trackId: string | null;
  lapsAnalyzed: number;
  lapTimeTrend: { lapNum: number; sessionUid: string; lapTimeSeconds: number; generatedAt: string }[];
  corners: CornerTrendPoint[];
  issues: IssueTrendPoint[];
}

function Panel({ title, subtitle, children, style }: { title: string; subtitle?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#14181D", border: "1px solid #262B33", borderRadius: 6,
      padding: "16px 18px", ...style
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{
          fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 13,
          letterSpacing: "0.08em", textTransform: "uppercase", color: "#E7EAEE"
        }}>{title}</div>
        {subtitle && <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#5B6572", marginTop: 2
        }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

const ISSUE_LABELS: Record<IssueKind, string> = {
  lockup: "Lockups",
  snap_correction: "Snap corrections",
  off_track_suspected: "Off-track (suspected)",
  engine_over_rev: "Over-revs",
};

function trendArrow(recent: number, earlier: number): { symbol: string; color: string } {
  if (recent < earlier) return { symbol: "\u2193", color: "#3DDC84" }; // down = improving (fewer issues)
  if (recent > earlier) return { symbol: "\u2191", color: "#FF5C77" }; // up = getting worse
  return { symbol: "\u2192", color: "#5B6572" };
}

function IssueTrendRow({ point }: { point: IssueTrendPoint }) {
  const arrow = trendArrow(point.recentHalfCount, point.earlierHalfCount);
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#B7BFC9",
      padding: "6px 0", borderBottom: "1px solid #1D2229",
    }}>
      <span>{ISSUE_LABELS[point.kind]}</span>
      <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: "#5B6572" }}>{point.totalCount} total</span>
        <span style={{ color: arrow.color, fontWeight: 700 }}>{arrow.symbol}</span>
      </span>
    </div>
  );
}

function CornerTrendRow({ point }: { point: CornerTrendPoint }) {
  const delta = point.recentTrendDelta;
  const deltaColor = delta == null ? "#5B6572" : delta >= 0 ? "#3DDC84" : "#FF5C77";
  const deltaLabel = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} km/h`;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "70px 1fr 1fr 90px", gap: 10, alignItems: "baseline",
      fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#B7BFC9",
      padding: "6px 0", borderBottom: "1px solid #1D2229",
    }}>
      <span style={{ color: "#E7EAEE" }}>T{point.cornerId} ({point.direction === "left" ? "L" : "R"})</span>
      <span title="Avg / best / worst min speed in corner across sampled laps">
        {point.avgMinSpeed.toFixed(0)} km/h avg
        <span style={{ color: "#5B6572" }}> ({point.worstMinSpeed.toFixed(0)}\u2013{point.bestMinSpeed.toFixed(0)})</span>
      </span>
      <span title="Braking-point consistency — lower is more consistent lap to lap">
        {point.brakePointStdDev != null ? `±${point.brakePointStdDev.toFixed(1)}m brake pt` : "—"}
      </span>
      <span style={{ color: deltaColor, textAlign: "right" }} title="Most recent lap's min speed vs. this driver's own prior average here">
        {deltaLabel}
      </span>
    </div>
  );
}

interface CoachingTrendsPanelProps {
  driverId?: string;
  trackId?: string;
  limit?: number;
}

export default function CoachingTrendsPanel({ driverId, trackId, limit }: CoachingTrendsPanelProps) {
  const [trends, setTrends] = useState<DriverCoachingTrends | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (driverId) params.set("driver_id", driverId);
    if (trackId) params.set("track_id", trackId);
    if (limit != null) params.set("limit", String(limit));

    const qs = params.toString();
    fetch(`/api/pitboss/telemetry/coach/trends${qs ? `?${qs}` : ""}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "failed to load coaching trends");
        return res.json();
      })
      .then((data: DriverCoachingTrends) => { if (!cancelled) setTrends(data); })
      .catch((err) => { if (!cancelled) setError(String(err.message ?? err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [driverId, trackId, limit]);

  if (loading) {
    return (
      <Panel title="Coaching Trends" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5B6572", padding: "20px 0" }}>
          Loading trend history…
        </div>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel title="Coaching Trends" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#FF5C77", padding: "20px 0" }}>
          Failed to load trends: {error}
        </div>
      </Panel>
    );
  }

  if (!trends || trends.lapsAnalyzed === 0) {
    return (
      <Panel title="Coaching Trends" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5B6572", padding: "20px 0" }}>
          Not enough coached laps yet{trends?.trackId ? " on this track" : ""} to show a trend. This fills in
          automatically as more valid laps get analyzed.
        </div>
      </Panel>
    );
  }

  const lapTimes = trends.lapTimeTrend.map((p) => p.lapTimeSeconds);
  const bestLapTime = lapTimes.length > 0 ? Math.min(...lapTimes) : null;
  const latestLapTime = lapTimes.length > 0 ? lapTimes[lapTimes.length - 1] : null;

  return (
    <Panel
      title="Coaching Trends"
      subtitle={`${trends.lapsAnalyzed} laps analyzed${trends.trackId ? "" : " across all tracks"}`}
      style={{ marginTop: 18 }}
    >
      {bestLapTime != null && latestLapTime != null && (
        <div style={{
          display: "flex", gap: 24, fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          color: "#B7BFC9", marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #1D2229",
        }}>
          <span>Best in window: <span style={{ color: "#E7EAEE" }}>{bestLapTime.toFixed(3)}s</span></span>
          <span>Most recent: <span style={{ color: "#E7EAEE" }}>{latestLapTime.toFixed(3)}s</span></span>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 11,
          letterSpacing: "0.06em", textTransform: "uppercase", color: "#5B6572", marginBottom: 6,
        }}>
          Issue frequency (recent half vs. earlier half of window)
        </div>
        {trends.issues.map((point) => <IssueTrendRow key={point.kind} point={point} />)}
      </div>

      {trends.corners.length > 0 && (
        <div>
          <div style={{
            fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 11,
            letterSpacing: "0.06em", textTransform: "uppercase", color: "#5B6572", marginBottom: 6,
          }}>
            Per-corner consistency
          </div>
          {trends.corners.map((point) => <CornerTrendRow key={point.cornerId} point={point} />)}
        </div>
      )}
      {trends.corners.length === 0 && !trends.trackId && (
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#5B6572" }}>
          Per-corner trends need a specific track — pass trackId to see corner-by-corner consistency.
        </div>
      )}
    </Panel>
  );
}
