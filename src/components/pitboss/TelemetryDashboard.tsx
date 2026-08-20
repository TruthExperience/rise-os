"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, Cell, ReferenceLine
} from "recharts";
import { CORNERS, cornerAvg, type Corner, type TelemetrySession } from "@/lib/telemetry";

const LAP_COLORS: Record<number, string> = {
  2: "#9B5DE5", 3: "#00C853", 4: "#FFC400",
  5: "#00B8D9", 6: "#FF5C77", 7: "#5DA9E9",
};

const POLL_INTERVAL_MS = 3000;

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

function Panel({ title, subtitle, children, style, badge }: { title: string; subtitle?: string; children: React.ReactNode; style?: React.CSSProperties; badge?: React.ReactNode }) {
  return (
    <div style={{
      background: "#14181D", border: "1px solid #262B33", borderRadius: 6,
      padding: "16px 18px", ...style
    }}>
      <div style={{ marginBottom: 10, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{
            fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 13,
            letterSpacing: "0.08em", textTransform: "uppercase", color: "#E7EAEE"
          }}>{title}</div>
          {subtitle && <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#5B6572", marginTop: 2
          }}>{subtitle}</div>}
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}

function LiveBadge({ status }: { status: "live" | "finished" | null }) {
  if (!status) return null;
  if (status === "live") {
    return (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
        color: "#FF5C77", letterSpacing: "0.06em"
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%", background: "#FF5C77",
          animation: "pb-live-pulse 1.4s ease-in-out infinite"
        }} />
        LIVE
        <style>{`@keyframes pb-live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }`}</style>
      </div>
    );
  }
  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#5B6572" }}>
      SESSION FINISHED
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

  // True until the user manually toggles a lap chip — while true, newly
  // arrived laps auto-add to the selection so a live session keeps showing
  // its latest laps without the user having to re-select each time.
  const autoFollowRef = useRef(true);

  // Highest lap_num we've merged in, used to ask the API for only what's new.
  const maxLapNumRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    autoFollowRef.current = true;
    maxLapNumRef.current = undefined;
    setSession(null);
    setLoadError(null);

    const poll = () => {
      const since = maxLapNumRef.current;
      const url = `/api/pitboss/telemetry?session_uid=${encodeURIComponent(sessionUid)}` +
        (since != null ? `&since_lap_num=${since}` : "");

      fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error ?? "failed to load telemetry");
          return res.json();
        })
        .then((incoming: TelemetrySession) => {
          if (cancelled) return;
          setLoadError(null);

          setSession((prev) => {
            if (!prev) return incoming;
            if (incoming.laps.length === 0) {
              // No new laps — still refresh status/lastUpdatedAt so the
              // live badge and any staleness UI stay accurate.
              return { ...prev, status: incoming.status, lastUpdatedAt: incoming.lastUpdatedAt };
            }
            const byLap = new Map(prev.laps.map((l) => [l.lapNum, l]));
            for (const lap of incoming.laps) byLap.set(lap.lapNum, lap);
            const merged = [...byLap.values()].sort((a, b) => a.lapNum - b.lapNum);
            return { ...incoming, laps: merged };
          });

          if (incoming.laps.length > 0) {
            const newest = incoming.laps[incoming.laps.length - 1].lapNum;
            maxLapNumRef.current =
              maxLapNumRef.current != null ? Math.max(maxLapNumRef.current, newest) : newest;

            if (autoFollowRef.current) {
              setSelected((prevSel) => {
                const next = new Set(prevSel);
                for (const lap of incoming.laps) next.add(lap.lapNum);
                return next;
              });
            }
          }
        })
        .catch((err) => { if (!cancelled) setLoadError(String(err.message ?? err)); });
    };

    poll();
    const id = setInterval(() => {
      // Stop polling once we know the session finished — one last poll
      // already confirmed that via `status`, no need to keep hitting the API.
      setSession((current) => {
        if (current?.status === "finished") {
          clearInterval(id);
        }
        return current;
      });
      poll();
    }, POLL_INTERVAL_MS);

    return () => { cancelled = true; clearInterval(id); };
  }, [sessionUid]);

  const laps = useMemo(() => session?.laps.map(l => l.lapNum) ?? [], [session]);
  const fastest = useMemo(() => {
    if (!session || session.laps.length === 0) return null;
    return session.laps.reduce((a, b) => (a.lapTime < b.lapTime ? a : b)).lapNum;
  }, [session]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [refLap, setRefLap] = useState<number | null>(null);

  useEffect(() => {
    if (session && selected.size === 0 && session.laps.length > 0) {
      setSelected(new Set(laps));
      setRefLap(fastest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // refLap should track the latest lap automatically while following live,
  // same as the original behavior of defaulting to the fastest lap on load.
  useEffect(() => {
    if (autoFollowRef.current && fastest != null) setRefLap(fastest);
  }, [fastest]);

  const toggle = (l: number) => {
    autoFollowRef.current = false;
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
    const validLapsArr = lapsArr.filter(l => lapByNum.has(l));
    if (validLapsArr.length === 0) return out;

    const baseLap = validLapsArr.reduce((a, b) =>
      (lapByNum.get(b)!.frames.length > lapByNum.get(a)!.frames.length ? b : a));
    const baseFrames = lapByNum.get(baseLap)!.frames;

    function nearestFrame(lap: number, d: number) {
      const rows = lapByNum.get(lap)!.frames;
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
      validLapsArr.forEach(l => {
        const lapFrames = lapByNum.get(l)!.frames;
        if (lapFrames.length === 0) return;
        const row = nearestFrame(l, d);
        speedPoint[`lap${l}`] = row.speed;
        tbPoint[`throttle${l}`] = row.throttle;
        tbPoint[`brake${l}`] = row.brake;
        tyrePoint[`lap${l}`] = cornerValue(row.tyreTemp, tyreCorner);
        brakePoint[`lap${l}`] = cornerValue(row.brakeTemp, brakeCorner);
      });
      out.speed.push(speedPoint);
      out.throttleBrake.push(tbPoint);
      out.tyreTemp.push(tyrePoint);
      out.brakeTemp.push(brakePoint);
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, selected, tyreCorner, brakeCorner]);

  const lapsArr = [...selected].sort((a, b) => a - b);

  const trackPoints = useMemo(() => {
    if (!session || refLap == null) return [];
    const lap = session.laps.find(l => l.lapNum === refLap);
    if (!lap || lap.frames.length === 0) return [];
    const speeds = lap.frames.map(f => f.speed);
    const min = Math.min(...speeds), max = Math.max(...speeds);
    return lap.frames
      .filter((_, i) => i % 3 === 0)
      .map(f => ({ x: f.x, y: f.y, fill: speedColor(f.speed, min, max) }));
  }, [session, refLap]);

  const ggPoints = useMemo(() => {
    if (!session || refLap == null) return [];
    const lap = session.laps.find(l => l.lapNum === refLap);
    if (!lap) return [];
    return lap.frames.filter((_, i) => i % 2 === 0).map(f => ({ x: f.gLat, y: f.gLon }));
  }, [session, refLap]);

  const bestSector = useMemo(() => {
    if (!session || session.laps.length === 0) return { s1: Infinity, s2: Infinity, s3: Infinity };
    return {
      s1: Math.min(...session.laps.map(l => l.sector1)),
      s2: Math.min(...session.laps.map(l => l.sector2)),
      s3: Math.min(...session.laps.map(l => l.sector3)),
    };
  }, [session]);

  const bestLapTime = useMemo(() => {
    if (!session || session.laps.length === 0) return Infinity;
    return Math.min(...session.laps.map(l => l.lapTime));
  }, [session]);

  if (loadError && !session) {
    return (
      <div style={{ padding: 24, fontFamily: "'JetBrains Mono', monospace", color: "#FF5C77" }}>
        {loadError}
      </div>
    );
  }

  if (!session || session.laps.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: "'JetBrains Mono', monospace", color: "#5B6572" }}>
        Waiting for telemetry…
      </div>
    );
  }

  const firstLap = session.laps[0];

  return (
    <div style={{ padding: 20, background: "#0B0D10", minHeight: "100vh" }}>
      {loadError && (
        <div style={{
          marginBottom: 12, padding: "8px 12px", borderRadius: 4,
          background: "#2A1519", border: "1px solid #4A2229",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "#FF8A9B"
        }}>
          Last poll failed: {loadError} — showing most recent data.
        </div>
      )}

      <Panel title="Lap Times" subtitle={firstLap.track} style={{ marginBottom: 18 }} badge={<LiveBadge status={session.status} />}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: "#5B6572", textAlign: "right" }}>
              <th style={{ padding: "4px 8px", textAlign: "left" }}>LAP</th>
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
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => Math.round(v)} stroke="#262B33" />
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
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => Math.round(v)} stroke="#262B33" />
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
              <div key={l} onClick={() => { autoFollowRef.current = false; setRefLap(l); }} style={{ ...chipStyle(refLap === l, LAP_COLORS[l] ?? "#5B6572"), padding: "3px 9px", fontSize: 11 }}>
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
              <Scatter data={ggPoints} fill={refLap != null ? LAP_COLORS[refLap] : "#5B6572"} fillOpacity={0.45} isAnimationActive={false} />
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
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => Math.round(v)} stroke="#262B33" />
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
            <XAxis dataKey="dist" tick={axisStyle} tickFormatter={v => Math.round(v)} stroke="#262B33" />
            <YAxis tick={axisStyle} stroke="#262B33" domain={["dataMin - 20", "dataMax + 20"]} />
            <Tooltip content={<CustomTooltip unit="°C" />} />
            {lapsArr.map(l => (
              <Line key={l} type="monotone" dataKey={`lap${l}`} stroke={LAP_COLORS[l]} dot={false} strokeWidth={l === fastest ? 2.4 : 1.4} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <div style={{ marginTop: 22, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#3D444D" }}>
        Session {session.sessionUid} · Laps {laps[0]}–{laps[laps.length - 1]} · {firstLap.track}
        {session.lastUpdatedAt && <> · updated {new Date(session.lastUpdatedAt).toLocaleTimeString()}</>}
      </div>
    </div>
  );
}
