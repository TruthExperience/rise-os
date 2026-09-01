"use client";

import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, Cell, ReferenceLine
} from "recharts";
import { CORNERS, cornerAvg, type Corner, type TelemetrySession } from "@/lib/telemetry-types";
import CoachingPanel from "@/components/pitboss/CoachingPanel";
import CoachingTrendsPanel from "@/components/pitboss/CoachingTrendsPanel";

const LAP_COLORS: Record<number, string> = {
  2: "#9B5DE5", 3: "#00C853", 4: "#FFC400",
  5: "#00B8D9", 6: "#FF5C77", 7: "#5DA9E9",
};

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

function speedColor(v: number, min: number, max: number) {
  const t = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
  const stops: [number, number, number, number][] = [
    [0, 68, 178, 216],
    [0.5, 155, 93, 229],
    [1, 255, 196, 0],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  const lt = (t - a[0]) / span;
  const r = Math.round(a[1] + (b[1] - a[1]) * lt);
  const g = Math.round(a[2] + (b[2] - a[2]) * lt);
  const bl = Math.round(a[3] + (b[3] - a[3]) * lt);
  return `rgb(${r},${g},${bl})`;
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

const chipStyle = (active: boolean, color: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
  padding: "6px 12px", borderRadius: 999, border: `1px solid ${active ? color : "#2B313A"}`,
  background: active ? `${color}1A` : "transparent",
  fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5,
  color: active ? color : "#5B6572", userSelect: "none", transition: "all .15s ease"
});

const axisStyle = { fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fill: "#5B6572" };

function CustomTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#0E1116", border: "1px solid #262B33", borderRadius: 4,
      padding: "8px 10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5
    }}>
      <div style={{ color: "#5B6572", marginBottom: 4 }}>{Math.round(label)}m</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 14, color: p.stroke }}>
          <span>{p.name ?? p.dataKey}</span>
          <span>{typeof p.value === "number" ? p.value.toFixed(1) : p.value}{unit || ""}</span>
        </div>
      ))}
    </div>
  );
}

// "avg" or one of the four corners — governs which trace the temp panels plot.
type CornerSelection = "avg" | Corner;
const CORNER_OPTIONS: CornerSelection[] = ["avg", ...CORNERS];

export default function TelemetryDashboard({ sessionUid }: { sessionUid: string }) {
  const [session, setSession] = useState<TelemetrySession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tyreCorner, setTyreCorner] = useState<CornerSelection>("avg");
  const [brakeCorner, setBrakeCorner] = useState<CornerSelection>("avg");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pitboss/telemetry?session_uid=${encodeURIComponent(sessionUid)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "failed to load telemetry");
        return res.json();
      })
      .then((data: TelemetrySession) => { if (!cancelled) setSession(data); })
      .catch((err) => { if (!cancelled) setLoadError(String(err.message ?? err)); });
    return () => { cancelled = true; };
  }, [sessionUid]);

  const laps = useMemo(() => session?.laps.map(l => l.lapNum) ?? [], [session]);
  const fastest = useMemo(() => {
    if (!session) return null;
    return session.laps.reduce((a, b) => (a.lapTime < b.lapTime ? a : b)).lapNum;
  }, [session]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refLap, setRefLap] = useState<number | null>(null);

  useEffect(() => {
    if (session && selected.size === 0) {
      setSelected(new Set(laps));
      setRefLap(fastest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const toggle = (l: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(l)) { if (next.size > 1) next.delete(l); }
      else next.add(l);
      return next;
    });
  };

  const cornerValue = (rec: Record<Corner, number>, sel: CornerSelection) =>
    sel === "avg" ? cornerAvg(rec) : rec[sel];

  const metricSeries = useMemo(() => {
    const out = { speed: [] as any[], throttleBrake: [] as any[], tyreTemp: [] as any[], brakeTemp: [] as any[] };
    if (!session) return out;

    const lapsArr = [...selected].sort((a, b) => a - b);
    if (lapsArr.length === 0) return out;

    const lapByNum = new Map(session.laps.map(l => [l.lapNum, l]));
    const baseLap = lapsArr.reduce((a, b) =>
      (lapByNum.get(b)!.frames.length > lapByNum.get(a)!.frames.length ? b : a));
    const baseFrames = lapByNum.get(baseLap)!.frames;

    // Guards against a lap with zero frames (e.g. malformed/missing raw_payload) —
    // without this, rows[0] on an empty array returns undefined and the .speed
    // access below throws.
    function nearestFrame(lap: number, d: number) {
      const rows = lapByNum.get(lap)!.frames;
      if (rows.length === 0) return null;
      let lo = 0, hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].dist < d) lo = mid + 1; else hi = mid;
      }
      return rows[lo];
    }

    baseFrames.forEach((f, i) => {
      if (i % 2 !== 0) return;
      const d = f.dist;
      const speedPoint: any = { dist: d };
      const tbPoint: any = { dist: d };
      const tyrePoint: any = { dist: d };
      const brakePoint: any = { dist: d };
      lapsArr.forEach(l => {
        const row = nearestFrame(l, d);
        if (!row) return;
        speedPoint[`lap${l}`] = row.speed;
        tbPoint[`throttle${l}`] = row.throttle * 100;
        tbPoint[`brake${l}`] = row.brake * 100;
        tyrePoint[`lap${l}`] = cornerValue(row.tyreTemp, tyreCorner);
        brakePoint[`lap${l}`] = cornerValue(row.brakeTemp, brakeCorner);
      });
      out.speed.push(speedPoint);
      out.throttleBrake.push(tbPoint);
      out.tyreTemp.push(tyrePoint);
      out.brakeTemp.push(brakePoint);
    });
    return out;
  }, [session, selected, tyreCorner, brakeCorner]);

  const trackPoints = useMemo(() => {
    if (!session || refLap == null) return [];
    const lap = session.laps.find(l => l.lapNum === refLap);
    if (!lap) return [];
    const speeds = lap.frames.map(f => f.speed);
    const min = Math.min(...speeds), max = Math.max(...speeds);
    return lap.frames.map(f => ({
      x: f.x, y: f.y, speed: f.speed,
      fill: speedColor(f.speed, min, max)
    }));
  }, [session, refLap]);

  const ggPoints = useMemo(() => {
    if (!session || refLap == null) return [];
    const lap = session.laps.find(l => l.lapNum === refLap);
    return lap ? lap.frames.map(f => ({ x: f.gLat, y: f.gLon })) : [];
  }, [session, refLap]);

  if (loadError) {
    return <div style={{ padding: 40, color: "#FF5C77", fontFamily: "'JetBrains Mono', monospace" }}>
      Failed to load telemetry: {loadError}
    </div>;
  }
  if (!session || fastest == null || refLap == null) {
    return <div style={{ padding: 40, color: "#5B6572", fontFamily: "'JetBrains Mono', monospace" }}>
      Loading telemetry…
    </div>;
  }

  const bestSector = {
    s1: Math.min(...session.laps.map(m => m.sector1)),
    s2: Math.min(...session.laps.map(m => m.sector2)),
    s3: Math.min(...session.laps.map(m => m.sector3)),
  };
  const bestLapTime = Math.min(...session.laps.map(m => m.lapTime));
  const lapsArr = [...selected].sort((a, b) => a - b);
  const firstLap = session.laps[0];

  return (
    <div style={{
      minHeight: "100vh", background: "#0B0E11", color: "#E7EAEE",
      fontFamily: "'Inter', 'Titillium Web', sans-serif", padding: "24px 28px 60px"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Titillium+Web:wght@400;600;700;900&family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { height: 6px; width: 6px; }
        ::-webkit-scrollbar-thumb { background: #262B33; border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Titillium Web', sans-serif", fontWeight: 900, fontSize: 26, letterSpacing: "0.02em" }}>
            {(firstLap.track ?? "").toUpperCase()} <span style={{ color: "#5B6572", fontWeight: 400 }}>· TELEMETRY</span>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#5B6572", marginTop: 4 }}>
            {(firstLap.tyres ?? "").toUpperCase()} · Track {firstLap.trackTemp}°C / Air {firstLap.airTemp}°C
          </div>
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#9B5DE5", border: "1px solid #9B5DE5", borderRadius: 4, padding: "6px 10px" }}>
          BEST LAP {fmtTime(bestLapTime)} — L{fastest}
        </div>
      </div>

      {/* Timing tower */}
      <Panel title="Timing Tower" style={{ marginBottom: 18, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, minWidth: 520 }}>
          <thead>
            <tr style={{ color: "#5B6572", textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>LAP</th>
              <th style={{ padding: "4px 8px" }}>S1</th>
              <th style={{ padding: "4px 8px" }}>S2</th>
              <th style={{ padding: "4px 8px" }}>S3</th>
              <th style={{ padding: "4px 8px" }}>LAP TIME</th>
              <th style={{ padding: "4px 8px" }}>GAP</th>
            </tr>
          </thead>
          <tbody>
            {session.laps.map(m => (
              <tr key={m.lapNum} style={{ borderTop: "1px solid #1D2229", textAlign: "right", opacity: selected.has(m.lapNum) ? 1 : 0.35 }}>
                <td style={{ textAlign: "left", padding: "6px 8px", color: LAP_COLORS[m.lapNum] ?? "#E7EAEE", fontWeight: 700 }}>
                  L{m.lapNum} {m.lapNum === fastest && "★"}
                </td>
                <td style={{ padding: "6px 8px", color: m.sector1 === bestSector.s1 ? "#9B5DE5" : "#B7BFC9" }}>{m.sector1.toFixed(3)}</td>
                <td style={{ padding: "6px 8px", color: m.sector2 === bestSector.s2 ? "#9B5DE5" : "#B7BFC9" }}>{m.sector2.toFixed(3)}</td>
                <td style={{ padding: "6px 8px", color: m.sector3 === bestSector.s3 ? "#9B5DE5" : "#B7BFC9" }}>{m.sector3.toFixed(3)}</td>
                <td style={{ padding: "6px 8px", color: m.lapTime === bestLapTime ? "#00C853" : "#E7EAEE", fontWeight: 700 }}>{fmtTime(m.lapTime)}</td>
                <td style={{ padding: "6px 8px", color: "#5B6572" }}>
                  {m.lapTime === bestLapTime ? "—" : `+${(m.lapTime - bestLapTime).toFixed(3)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Lap selector */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        {laps.map(l => (
          <div key={l} style={chipStyle(selected.has(l), LAP_COLORS[l] ?? "#5B6572")} onClick={() => toggle(l)}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: LAP_COLORS[l] ?? "#5B6572" }} />
            LAP {l} · {fmtTime(session.laps.find(m => m.lapNum === l)!.lapTime)}
          </div>
        ))}
      </div>

      {/* Speed trace */}
      <Panel title="Speed Trace" subtitle="km/h vs distance (m)" style={{ marginBottom: 18 }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={metricSeries.speed} syncId="tel" margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1D2229" vertical={false} />
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => String(Math.round(v))} stroke="#262B33" />
            <YAxis tick={axisStyle} stroke="#262B33" domain={[0, 340]} />
            <Tooltip content={<CustomTooltip unit=" km/h" />} />
            {lapsArr.map(l => (
              <Line key={l} type="monotone" dataKey={`lap${l}`} stroke={LAP_COLORS[l]} dot={false} strokeWidth={l === fastest ? 2.4 : 1.4} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      {/* Throttle / Brake */}
      <Panel title="Throttle & Brake" subtitle="% vs distance (m) · solid = throttle, dashed = brake" style={{ marginBottom: 18 }}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={metricSeries.throttleBrake} syncId="tel" margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1D2229" vertical={false} />
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => String(Math.round(v))} stroke="#262B33" />
            <YAxis tick={axisStyle} stroke="#262B33" domain={[0, 100]} />
            <Tooltip content={<CustomTooltip unit="%" />} />
            {lapsArr.map(l => (
              <Line key={`t${l}`} type="monotone" dataKey={`throttle${l}`} stroke={LAP_COLORS[l]} dot={false} strokeWidth={1.4} isAnimationActive={false} />
            ))}
            {lapsArr.map(l => (
              <Line key={`b${l}`} type="monotone" dataKey={`brake${l}`} stroke={LAP_COLORS[l]} strokeDasharray="3 3" dot={false} strokeWidth={1.4} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 18, marginBottom: 18 }}>
        {/* Track map */}
        <Panel title="Track Map" subtitle={`speed heatmap · reference lap ${refLap}`}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {laps.map(l => (
              <div key={l} onClick={() => setRefLap(l)} style={{ ...chipStyle(refLap === l, LAP_COLORS[l] ?? "#5B6572"), padding: "3px 9px", fontSize: 11 }}>
                L{l}
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
              <XAxis type="number" dataKey="x" hide domain={["dataMin - 20", "dataMax + 20"]} />
              <YAxis type="number" dataKey="y" hide domain={["dataMin - 20", "dataMax + 20"]} />
              <Scatter data={trackPoints} isAnimationActive={false}>
                {trackPoints.map((p, i) => <Cell key={i} fill={p.fill} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#5B6572", marginTop: 4 }}>
            <span style={{ color: "#4488D8" }}>● slow</span>
            <span style={{ color: "#9B5DE5" }}>● mid</span>
            <span style={{ color: "#FFC400" }}>● fast</span>
          </div>
        </Panel>

        {/* G-G diagram */}
        <Panel title="G-G Diagram" subtitle={`lateral vs longitudinal G · lap ${refLap}`}>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid stroke="#1D2229" />
              <XAxis type="number" dataKey="x" tick={axisStyle} stroke="#262B33" domain={[-4, 4]} label={{ value: "lateral", position: "insideBottom", fill: "#5B6572", fontSize: 10, dy: 10 }} />
              <YAxis type="number" dataKey="y" tick={axisStyle} stroke="#262B33" domain={[-4, 4]} label={{ value: "longitudinal", angle: -90, position: "insideLeft", fill: "#5B6572", fontSize: 10 }} />
              <ReferenceLine x={0} stroke="#262B33" />
              <ReferenceLine y={0} stroke="#262B33" />
              <Scatter data={ggPoints} fill={LAP_COLORS[refLap]} fillOpacity={0.45} isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* Tyre temps — per-corner selector, default avg */}
      <Panel
        title="Tyre Surface Temperature"
        subtitle={`°C vs distance (m) · ${tyreCorner === "avg" ? "avg of 4 corners" : tyreCorner}`}
        style={{ marginBottom: 18 }}
      >
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {CORNER_OPTIONS.map(c => (
            <div key={c} onClick={() => setTyreCorner(c)} style={{ ...chipStyle(tyreCorner === c, "#00C853"), padding: "3px 9px", fontSize: 11 }}>
              {c.toUpperCase()}
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={metricSeries.tyreTemp} syncId="tel" margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1D2229" vertical={false} />
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => String(Math.round(v))} stroke="#262B33" />
            <YAxis tick={axisStyle} stroke="#262B33" domain={["dataMin - 5", "dataMax + 5"]} />
            <Tooltip content={<CustomTooltip unit="°C" />} />
            {lapsArr.map(l => (
              <Line key={l} type="monotone" dataKey={`lap${l}`} stroke={LAP_COLORS[l]} dot={false} strokeWidth={l === fastest ? 2.4 : 1.4} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      {/* Brake temps — same per-corner pattern */}
      <Panel
        title="Brake Temperature"
        subtitle={`°C vs distance (m) · ${brakeCorner === "avg" ? "avg of 4 corners" : brakeCorner}`}
      >
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {CORNER_OPTIONS.map(c => (
            <div key={c} onClick={() => setBrakeCorner(c)} style={{ ...chipStyle(brakeCorner === c, "#FF5C77"), padding: "3px 9px", fontSize: 11 }}>
              {c.toUpperCase()}
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={metricSeries.brakeTemp} syncId="tel" margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="#1D2229" vertical={false} />
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => String(Math.round(v))} stroke="#262B33" />
            <YAxis tick={axisStyle} stroke="#262B33" domain={["dataMin - 20", "dataMax + 20"]} />
            <Tooltip content={<CustomTooltip unit="°C" />} />
            {lapsArr.map(l => (
              <Line key={l} type="monotone" dataKey={`lap${l}`} stroke={LAP_COLORS[l]} dot={false} strokeWidth={l === fastest ? 2.4 : 1.4} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      {/* Coaching — analyzes the currently-selected track-map/G-G lap
          (refLap), compared against the fastest lap unless refLap already
          is the fastest lap (comparing a lap to itself is a no-op). */}
      <CoachingPanel
        sessionUid={session.sessionUid}
        lapNum={refLap}
        referenceLapNum={refLap !== fastest ? fastest : undefined}
      />

      {/* Season-long trends — aggregates every coached lap this driver
          has on record (not just this session). Corner-level consistency
          is track-scoped so it's omitted here (no track_id available
          client-side, only the track name string) — lap-time and issue-
          frequency trends still work fine across all tracks. */}
      {session.driverId && (
        <CoachingTrendsPanel driverId={session.driverId} />
      )}

      <div style={{ marginTop: 22, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#3D444D" }}>
        Session {session.sessionUid} · Laps {laps[0]}–{laps[laps.length - 1]} · {firstLap.track}
      </div>
    </div>
  );
}
