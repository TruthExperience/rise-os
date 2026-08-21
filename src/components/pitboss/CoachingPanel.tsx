"use client";

import React, { useEffect, useState } from "react";
import type {
  CoachingReport,
  CornerCoaching,
  StraightCoaching,
  DetectedIssue,
} from "@/lib/pitboss/telemetry-coach-types";

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

const badgeStyle = (color: string): React.CSSProperties => ({
  display: "inline-block", fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
  color, border: `1px solid ${color}`, borderRadius: 999, padding: "2px 8px",
  textTransform: "uppercase", letterSpacing: "0.05em",
});

const severityColor = (sev: DetectedIssue["severity"]) => (sev === "major" ? "#FF5C77" : "#FFC400");

function TipLine({ text, color }: { text: string; color: string }) {
  return (
    <div style={{
      fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#E7EAEE",
      lineHeight: 1.45, marginTop: 8, paddingTop: 8, borderTop: "1px dashed #1D2229",
      display: "flex", gap: 8,
    }}>
      <span style={{ color, fontWeight: 700, flexShrink: 0 }}>TIP</span>
      <span>{text}</span>
    </div>
  );
}

function IssueRow({ issue }: { issue: DetectedIssue }) {
  return (
    <div style={{
      display: "flex", gap: 10, alignItems: "baseline",
      fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#B7BFC9",
      padding: "4px 0",
    }}>
      <span style={badgeStyle(severityColor(issue.severity))}>{issue.severity}</span>
      <span style={{ color: "#5B6572" }}>{Math.round(issue.dist)}m</span>
      <span>{issue.note}</span>
    </div>
  );
}

function CornerCard({ corner }: { corner: CornerCoaching }) {
  const { corner: seg, braking, throttle, issues, coachingNote, suggestion } = corner;
  const hasMajorIssue = issues.some((iss: DetectedIssue) => iss.severity === "major");

  return (
    <div style={{
      border: "1px solid #1D2229", borderRadius: 6, padding: "12px 14px",
      background: "#0E1116",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{
          fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 13, color: "#E7EAEE"
        }}>
          CORNER {seg.id + 1} <span style={{ color: "#5B6572", fontWeight: 400 }}>· {seg.direction.toUpperCase()}</span>
        </div>
        {issues.length > 0 && (
          <span style={badgeStyle(hasMajorIssue ? "#FF5C77" : "#FFC400")}>
            {issues.length} issue{issues.length > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#B7BFC9", marginBottom: 10
      }}>
        <div><span style={{ color: "#5B6572" }}>Brake pt</span> {Math.round(braking.brakePointDist)}m</div>
        <div><span style={{ color: "#5B6572" }}>Min speed</span> {Math.round(braking.minSpeedInCorner)} km/h</div>
        <div><span style={{ color: "#5B6572" }}>Peak brake</span> {(braking.brakePeakPressure * 100).toFixed(0)}%</div>
        <div><span style={{ color: "#5B6572" }}>Trail brake</span> {(braking.trailBrakePercent * 100).toFixed(0)}%</div>
        <div><span style={{ color: "#5B6572" }}>Throttle @</span> {throttle.distFromApexToThrottle >= 0 ? "+" : ""}{Math.round(throttle.distFromApexToThrottle)}m from apex</div>
        <div><span style={{ color: "#5B6572" }}>Full throttle</span> {throttle.fullThrottleDist != null ? `${Math.round(throttle.fullThrottleDist)}m` : "—"}</div>
      </div>

      {coachingNote && (
        <div style={{
          fontFamily: "'Inter', sans-serif", fontSize: 12.5, color: "#E7EAEE",
          lineHeight: 1.5, borderTop: "1px solid #1D2229", paddingTop: 10,
        }}>
          {coachingNote}
        </div>
      )}

      {issues.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid #1D2229", paddingTop: 6 }}>
          {issues.map((iss: DetectedIssue, i: number) => <IssueRow key={i} issue={iss} />)}
        </div>
      )}

      {suggestion && <TipLine text={suggestion} color="#00C853" />}
    </div>
  );
}

function StraightCard({ straight }: { straight: StraightCoaching }) {
  const { straight: seg, analysis, coachingNote, suggestion } = straight;
  return (
    <div style={{
      border: "1px solid #1D2229", borderRadius: 6, padding: "12px 14px",
      background: "#0B0E11", // slightly darker than corner cards — visually distinct at a glance
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{
          fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 13, color: "#5DA9E9"
        }}>
          STRAIGHT <span style={{ color: "#5B6572", fontWeight: 400 }}>
            {seg.afterCornerId != null ? `after C${seg.afterCornerId + 1}` : "start"}
            {" → "}
            {seg.beforeCornerId != null ? `C${seg.beforeCornerId + 1}` : "finish"}
          </span>
        </div>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#B7BFC9", marginBottom: 10
      }}>
        <div><span style={{ color: "#5B6572" }}>Length</span> {Math.round(analysis.lengthMeters)}m</div>
        <div><span style={{ color: "#5B6572" }}>Top speed</span> {Math.round(analysis.topSpeed)} km/h</div>
        <div><span style={{ color: "#5B6572" }}>Avg throttle</span> {(analysis.avgThrottle * 100).toFixed(0)}%</div>
        <div><span style={{ color: "#5B6572" }}>DRS active</span> {(analysis.drsActivePercent * 100).toFixed(0)}%</div>
        {analysis.deltaVsReferenceSeconds != null && (
          <div style={{ gridColumn: "1 / -1" }}>
            <span style={{ color: "#5B6572" }}>Delta here</span>{" "}
            <span style={{ color: analysis.deltaVsReferenceSeconds <= 0 ? "#00C853" : "#FF5C77", fontWeight: 700 }}>
              {analysis.deltaVsReferenceSeconds >= 0 ? "+" : ""}{analysis.deltaVsReferenceSeconds.toFixed(3)}s
            </span>
          </div>
        )}
      </div>

      {coachingNote && (
        <div style={{
          fontFamily: "'Inter', sans-serif", fontSize: 12.5, color: "#E7EAEE",
          lineHeight: 1.5, borderTop: "1px solid #1D2229", paddingTop: 10,
        }}>
          {coachingNote}
        </div>
      )}

      {suggestion && <TipLine text={suggestion} color="#5DA9E9" />}
    </div>
  );
}

type TrackSegment =
  | { kind: "corner"; startDist: number; data: CornerCoaching }
  | { kind: "straight"; startDist: number; data: StraightCoaching };

interface CoachingPanelProps {
  sessionUid: string;
  lapNum: number;
  referenceLapNum?: number;
}

export default function CoachingPanel({ sessionUid, lapNum, referenceLapNum }: CoachingPanelProps) {
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ session_uid: sessionUid, lap: String(lapNum) });
    if (referenceLapNum != null) params.set("reference_lap", String(referenceLapNum));

    fetch(`/api/pitboss/telemetry/coach?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "failed to load coaching report");
        return res.json();
      })
      .then((data: CoachingReport) => { if (!cancelled) setReport(data); })
      .catch((err) => { if (!cancelled) setError(String(err.message ?? err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [sessionUid, lapNum, referenceLapNum]);

  if (loading) {
    return (
      <Panel title="PitBoss Coach" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5B6572", padding: "20px 0" }}>
          Analyzing lap {lapNum}…
        </div>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel title="PitBoss Coach" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#FF5C77", padding: "20px 0" }}>
          Failed to load coaching report: {error}
        </div>
      </Panel>
    );
  }

  if (!report) return null;

  const cmp = report.comparison;

  // Merge corners and straights into one track-ordered list for rendering,
  // so the coaching timeline reads in the same order the car actually
  // drives the lap, rather than corners-then-straights.
  const segments: TrackSegment[] = [
    ...report.corners.map((c): TrackSegment => ({ kind: "corner", startDist: c.corner.entryDist, data: c })),
    ...report.straights.map((s): TrackSegment => ({ kind: "straight", startDist: s.straight.startDist, data: s })),
  ].sort((a, b) => a.startDist - b.startDist);

  return (
    <Panel
      title="PitBoss Coach"
      subtitle={`lap ${report.lapNum}${report.referenceLapNum != null ? ` vs lap ${report.referenceLapNum}` : ""}${report.narrativeSource === "deterministic" ? " · offline analysis" : ""}`}
      style={{ marginTop: 18 }}
    >
      <div style={{
        fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: "#E7EAEE",
        lineHeight: 1.55, marginBottom: 16,
      }}>
        {report.summaryText}
      </div>

      {report.suggestions.length > 0 && (
        <div style={{
          background: "#0E1116", border: "1px solid #1D2229", borderRadius: 6,
          padding: "12px 14px", marginBottom: 16,
        }}>
          <div style={{
            fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 11.5,
            letterSpacing: "0.06em", textTransform: "uppercase", color: "#00C853", marginBottom: 8,
          }}>
            Next Lap
          </div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {report.suggestions.map((s: string, i: number) => (
              <li key={i} style={{
                fontFamily: "'Inter', sans-serif", fontSize: 12.5, color: "#E7EAEE",
                lineHeight: 1.5, marginBottom: i < report.suggestions.length - 1 ? 6 : 0,
              }}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {cmp && (
        <div style={{
          display: "flex", gap: 18, flexWrap: "wrap",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#B7BFC9",
          marginBottom: 16, padding: "10px 0", borderTop: "1px solid #1D2229", borderBottom: "1px solid #1D2229",
        }}>
          <div>
            <span style={{ color: "#5B6572" }}>TOTAL </span>
            <span style={{ color: cmp.totalDeltaSeconds <= 0 ? "#00C853" : "#FF5C77", fontWeight: 700 }}>
              {cmp.totalDeltaSeconds >= 0 ? "+" : ""}{cmp.totalDeltaSeconds.toFixed(3)}s
            </span>
          </div>
          <div><span style={{ color: "#5B6572" }}>S1 </span>{cmp.sectorDeltas.sector1 >= 0 ? "+" : ""}{cmp.sectorDeltas.sector1.toFixed(3)}</div>
          <div><span style={{ color: "#5B6572" }}>S2 </span>{cmp.sectorDeltas.sector2 >= 0 ? "+" : ""}{cmp.sectorDeltas.sector2.toFixed(3)}</div>
          <div><span style={{ color: "#5B6572" }}>S3 </span>{cmp.sectorDeltas.sector3 >= 0 ? "+" : ""}{cmp.sectorDeltas.sector3.toFixed(3)}</div>
          {cmp.biggestGainZone && (
            <div style={{ color: "#00C853" }}>
              Best gain {cmp.biggestGainZone.gainedSeconds.toFixed(2)}s @ {Math.round(cmp.biggestGainZone.startDist)}–{Math.round(cmp.biggestGainZone.endDist)}m
            </div>
          )}
          {cmp.biggestLossZone && (
            <div style={{ color: "#FF5C77" }}>
              Biggest loss {cmp.biggestLossZone.lostSeconds.toFixed(2)}s @ {Math.round(cmp.biggestLossZone.startDist)}–{Math.round(cmp.biggestLossZone.endDist)}m
            </div>
          )}
        </div>
      )}

      {segments.length === 0 ? (
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5B6572" }}>
          No corners or straights detected for this lap.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {segments.map((seg) =>
            seg.kind === "corner"
              ? <CornerCard key={`corner-${seg.data.corner.id}`} corner={seg.data} />
              : <StraightCard key={`straight-${seg.data.straight.id}`} straight={seg.data} />
          )}
        </div>
      )}
    </Panel>
  );
}
