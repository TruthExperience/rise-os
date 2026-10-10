"use client";

// TelemetryReplay — plays a lap back as it happened.
//
// A playhead (elapsed lap time) drives everything at once: the car moves round
// the track map, the gauges and tyre/brake readouts update live, and every
// channel trace shows a cursor at the current point in the lap. An optional
// second lap is played alongside as a ghost, with a live gap.
//
// NOTE ON TIME: stored frames carry distance but no timestamp, so elapsed time
// is rebuilt by integrating distance over speed and scaling the total to the
// lap's recorded lap time. It is exact at the start and finish and a close
// estimate in between. If frames ever gain a real timestamp, replace
// prepareLap()'s `time` array with it and nothing else needs to change.

import React, { useEffect, useMemo, useState } from "react";
import {
  CORNERS,
  type Corner,
  type TelemetryFrame,
  type TelemetryLap,
  type TelemetrySession,
} from "@/lib/telemetry-types";

const PRIMARY = "#00B8D9";
const GHOST = "#FFC400";
const MONO = "'JetBrains Mono', monospace";
const CORNER_COLORS: Record<Corner, string> = {
  FL: "#00B8D9",
  FR: "#9B5DE5",
  RL: "#00C853",
  RR: "#FF5C77",
};

// ─── Data preparation ───────────────────────────────────────────────────────

interface PreparedLap {
  lapNum: number;
  lapTime: number;
  frames: TelemetryFrame[];
  time: number[]; // reconstructed elapsed seconds per frame
  totalTime: number;
  totalDist: number;
}

function prepareLap(lap: TelemetryLap): PreparedLap | null {
  const frames = lap.frames;
  if (!frames || frames.length < 2) return null;
  const time: number[] = new Array(frames.length);
  time[0] = 0;
  for (let i = 1; i < frames.length; i++) {
    const dd = Math.max(0, frames[i].dist - frames[i - 1].dist);
    const v = Math.max((frames[i].speed + frames[i - 1].speed) / 2 / 3.6, 1);
    time[i] = time[i - 1] + dd / v;
  }
  const raw = time[frames.length - 1];
  const total = lap.lapTime > 0 ? lap.lapTime : raw;
  const k = raw > 0 ? total / raw : 1;
  for (let i = 0; i < time.length; i++) time[i] *= k;
  return {
    lapNum: lap.lapNum,
    lapTime: lap.lapTime,
    frames,
    time,
    totalTime: total,
    totalDist: frames[frames.length - 1].dist,
  };
}

/** Smallest index in [0, len) where ge(i) is true, or len if none. */
function lowerBound(len: number, ge: (i: number) => boolean): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ge(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function lerpRec(
  a: Record<Corner, number>,
  b: Record<Corner, number>,
  f: number
): Record<Corner, number> {
  return {
    FL: lerp(a.FL, b.FL, f),
    FR: lerp(a.FR, b.FR, f),
    RL: lerp(a.RL, b.RL, f),
    RR: lerp(a.RR, b.RR, f),
  };
}

function lerpFrame(a: TelemetryFrame, b: TelemetryFrame, f: number): TelemetryFrame {
  return {
    dist: lerp(a.dist, b.dist, f),
    speed: lerp(a.speed, b.speed, f),
    throttle: lerp(a.throttle, b.throttle, f),
    brake: lerp(a.brake, b.brake, f),
    gear: f < 0.5 ? a.gear : b.gear,
    steer: lerp(a.steer, b.steer, f),
    drs: f < 0.5 ? a.drs : b.drs,
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    tyreTemp: lerpRec(a.tyreTemp, b.tyreTemp, f),
    tyreTempInner: lerpRec(a.tyreTempInner, b.tyreTempInner, f),
    brakeTemp: lerpRec(a.brakeTemp, b.brakeTemp, f),
    tyrePressure: lerpRec(a.tyrePressure, b.tyrePressure, f),
    tyreWear: lerpRec(a.tyreWear, b.tyreWear, f),
    rpm: lerp(a.rpm, b.rpm, f),
    gLat: lerp(a.gLat, b.gLat, f),
    gLon: lerp(a.gLon, b.gLon, f),
    fuel: lerp(a.fuel, b.fuel, f),
    ers: lerp(a.ers, b.ers, f),
    engineTemp: lerp(a.engineTemp, b.engineTemp, f),
  };
}

function sampleAtTime(p: PreparedLap, t: number): TelemetryFrame {
  const tt = Math.max(0, Math.min(t, p.totalTime));
  const i = lowerBound(p.time.length, (k) => p.time[k] >= tt);
  if (i <= 0) return p.frames[0];
  if (i >= p.frames.length) return p.frames[p.frames.length - 1];
  const span = p.time[i] - p.time[i - 1] || 1;
  return lerpFrame(p.frames[i - 1], p.frames[i], (tt - p.time[i - 1]) / span);
}

/** Elapsed time at which this lap reached distance d. */
function timeAtDist(p: PreparedLap, d: number): number {
  const i = lowerBound(p.frames.length, (k) => p.frames[k].dist >= d);
  if (i <= 0) return 0;
  if (i >= p.frames.length) return p.totalTime;
  const span = p.frames[i].dist - p.frames[i - 1].dist || 1;
  return lerp(p.time[i - 1], p.time[i], (d - p.frames[i - 1].dist) / span);
}

// ─── Channels ───────────────────────────────────────────────────────────────

interface Series {
  label: string;
  get: (f: TelemetryFrame) => number;
  color?: string;
}

interface Channel {
  id: string;
  label: string;
  unit: string;
  series: Series[];
  compare: boolean; // true: primary vs ghost; false: multi-series on the primary lap only
  digits: number;
}

function corners(get: (f: TelemetryFrame, c: Corner) => number): Series[] {
  return CORNERS.map((c) => ({ label: c, get: (f: TelemetryFrame) => get(f, c), color: CORNER_COLORS[c] }));
}

const GROUPS: { title: string; channels: Channel[] }[] = [
  {
    title: "Driver inputs",
    channels: [
      { id: "speed", label: "Speed", unit: "km/h", series: [{ label: "Speed", get: (f) => f.speed }], compare: true, digits: 0 },
      { id: "throttle", label: "Throttle", unit: "%", series: [{ label: "Throttle", get: (f) => f.throttle * 100 }], compare: true, digits: 0 },
      { id: "brake", label: "Brake", unit: "%", series: [{ label: "Brake", get: (f) => f.brake * 100 }], compare: true, digits: 0 },
      { id: "gear", label: "Gear", unit: "", series: [{ label: "Gear", get: (f) => f.gear }], compare: true, digits: 0 },
      { id: "steer", label: "Steering", unit: "°", series: [{ label: "Steer", get: (f) => f.steer }], compare: true, digits: 0 },
      { id: "drs", label: "DRS", unit: "", series: [{ label: "DRS", get: (f) => (f.drs ? 1 : 0) }], compare: true, digits: 0 },
    ],
  },
  {
    title: "Engine & energy",
    channels: [
      { id: "rpm", label: "RPM", unit: "rpm", series: [{ label: "RPM", get: (f) => f.rpm }], compare: true, digits: 0 },
      { id: "engineTemp", label: "Engine temp", unit: "°C", series: [{ label: "Engine", get: (f) => f.engineTemp }], compare: true, digits: 0 },
      { id: "ers", label: "ERS", unit: "", series: [{ label: "ERS", get: (f) => f.ers }], compare: true, digits: 0 },
      { id: "fuel", label: "Fuel", unit: "", series: [{ label: "Fuel", get: (f) => f.fuel }], compare: true, digits: 2 },
    ],
  },
  {
    title: "G-forces",
    channels: [
      { id: "gLat", label: "Lateral G", unit: "g", series: [{ label: "Lat", get: (f) => f.gLat }], compare: true, digits: 2 },
      { id: "gLon", label: "Longitudinal G", unit: "g", series: [{ label: "Lon", get: (f) => f.gLon }], compare: true, digits: 2 },
    ],
  },
  {
    title: "Tyres",
    channels: [
      { id: "tyreTemp", label: "Tyre surface temp", unit: "°C", series: corners((f, c) => f.tyreTemp[c]), compare: false, digits: 0 },
      { id: "tyreTempInner", label: "Tyre inner temp", unit: "°C", series: corners((f, c) => f.tyreTempInner[c]), compare: false, digits: 0 },
      { id: "tyrePressure", label: "Tyre pressure", unit: "psi", series: corners((f, c) => f.tyrePressure[c]), compare: false, digits: 1 },
      { id: "tyreWear", label: "Tyre wear", unit: "%", series: corners((f, c) => f.tyreWear[c]), compare: false, digits: 1 },
    ],
  },
  {
    title: "Brakes",
    channels: [
      { id: "brakeTemp", label: "Brake temp", unit: "°C", series: corners((f, c) => f.brakeTemp[c]), compare: false, digits: 0 },
    ],
  },
];

// ─── Small UI pieces ────────────────────────────────────────────────────────

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

function Panel({
  title,
  subtitle,
  children,
  style,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ background: "#12161B", border: "1px solid #1D232B", borderRadius: 8, padding: 14, ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9AA3AF" }}>
          {title}
        </div>
        {subtitle && <div style={{ fontFamily: MONO, fontSize: 10, color: "#5B6572" }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0)) * 100;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10, color: "#5B6572", marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: "#E7EAEE" }}>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 8, background: "#0B0E11", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: "#0B0E11", borderRadius: 6, padding: "6px 8px", minWidth: 0 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, color: "#5B6572", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 14, color: color ?? "#E7EAEE", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ─── Track map ──────────────────────────────────────────────────────────────

const MAP_W = 420;
const MAP_H = 300;
const MAP_PAD = 16;

function useTrackGeometry(frames: TelemetryFrame[]) {
  return useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of frames) {
      if (f.x < minX) minX = f.x;
      if (f.x > maxX) maxX = f.x;
      if (f.y < minY) minY = f.y;
      if (f.y > maxY) maxY = f.y;
    }
    const rx = maxX - minX || 1;
    const ry = maxY - minY || 1;
    const s = Math.min((MAP_W - MAP_PAD * 2) / rx, (MAP_H - MAP_PAD * 2) / ry);
    const offX = (MAP_W - rx * s) / 2;
    const offY = (MAP_H - ry * s) / 2;
    // y is flipped so that "up" on the map is +y, matching the static track map.
    const project = (x: number, y: number): [number, number] => [
      offX + (x - minX) * s,
      MAP_H - (offY + (y - minY) * s),
    ];
    const step = Math.max(1, Math.floor(frames.length / 500));
    const pts: string[] = [];
    for (let i = 0; i < frames.length; i += step) {
      const [px, py] = project(frames[i].x, frames[i].y);
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return { project, pts, step };
  }, [frames]);
}

// ─── Trace (one channel, synced cursor) ─────────────────────────────────────

const TRACE_W = 600;
const TRACE_H = 64;

function Trace({
  channel,
  primary,
  ghost,
  maxDist,
  cur,
  ghostCur,
}: {
  channel: Channel;
  primary: PreparedLap;
  ghost: PreparedLap | null;
  maxDist: number;
  cur: TelemetryFrame;
  ghostCur: TelemetryFrame | null;
}) {
  const paths = useMemo(() => {
    const lapsToDraw: { lap: PreparedLap; color: string | null }[] = [{ lap: primary, color: null }];
    if (channel.compare && ghost) lapsToDraw.push({ lap: ghost, color: GHOST });

    let min = Infinity;
    let max = -Infinity;
    const raw: { d: string; color: string }[] = [];
    const sampled: { color: string; xs: number[]; vs: number[] }[] = [];

    for (const { lap, color } of lapsToDraw) {
      const step = Math.max(1, Math.floor(lap.frames.length / 300));
      for (let si = 0; si < channel.series.length; si++) {
        const s = channel.series[si];
        const xs: number[] = [];
        const vs: number[] = [];
        for (let i = 0; i < lap.frames.length; i += step) {
          const v = s.get(lap.frames[i]);
          if (!Number.isFinite(v)) continue;
          xs.push((lap.frames[i].dist / maxDist) * TRACE_W);
          vs.push(v);
          if (v < min) min = v;
          if (v > max) max = v;
        }
        sampled.push({ color: color ?? s.color ?? PRIMARY, xs, vs });
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { raw, min: 0, max: 1 };
    if (max === min) max = min + 1;
    const pad = (max - min) * 0.08;
    const lo = min - pad;
    const hi = max + pad;
    for (const sp of sampled) {
      const parts: string[] = [];
      for (let i = 0; i < sp.xs.length; i++) {
        const y = TRACE_H - ((sp.vs[i] - lo) / (hi - lo)) * TRACE_H;
        parts.push(`${i === 0 ? "M" : "L"}${sp.xs[i].toFixed(1)} ${y.toFixed(1)}`);
      }
      raw.push({ d: parts.join(" "), color: sp.color });
    }
    return { raw, min, max };
  }, [channel, primary, ghost, maxDist]);

  const cx = (cur.dist / maxDist) * TRACE_W;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6, marginBottom: 2 }}>
        <div style={{ fontFamily: MONO, fontSize: 11, color: "#9AA3AF" }}>
          {channel.label}
          {channel.unit ? <span style={{ color: "#5B6572" }}> · {channel.unit}</span> : null}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {channel.series.map((s) => (
            <span key={s.label} style={{ color: s.color ?? PRIMARY }}>
              {channel.series.length > 1 ? `${s.label} ` : ""}
              {s.get(cur).toFixed(channel.digits)}
            </span>
          ))}
          {channel.compare && ghostCur && (
            <span style={{ color: GHOST }}>{channel.series[0].get(ghostCur).toFixed(channel.digits)}</span>
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${TRACE_W} ${TRACE_H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: TRACE_H, background: "#0B0E11", borderRadius: 4, display: "block" }}
      >
        {paths.raw.map((p, i) => (
          <path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={cx} x2={cx} y1={0} y2={TRACE_H} stroke="#E7EAEE" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.8} />
      </svg>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

const RATES = [0.25, 0.5, 1, 2, 4];

const selectStyle: React.CSSProperties = {
  background: "#0B0E11",
  color: "#E7EAEE",
  border: "1px solid #262B33",
  borderRadius: 4,
  padding: "6px 8px",
  fontFamily: MONO,
  fontSize: 12,
};

export default function TelemetryReplay({
  session,
  defaultLap,
}: {
  session: TelemetrySession;
  defaultLap: number;
}) {
  const prepared = useMemo(() => {
    const m = new Map<number, PreparedLap>();
    for (const lap of session.laps) {
      const p = prepareLap(lap);
      if (p) m.set(lap.lapNum, p);
    }
    return m;
  }, [session]);

  const lapNums = useMemo(() => [...prepared.keys()].sort((a, b) => a - b), [prepared]);

  const [primaryNum, setPrimaryNum] = useState<number>(
    prepared.has(defaultLap) ? defaultLap : lapNums[0] ?? defaultLap
  );
  const [ghostNum, setGhostNum] = useState<number | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  const primary = prepared.get(primaryNum) ?? null;
  const ghost = ghostNum != null && ghostNum !== primaryNum ? prepared.get(ghostNum) ?? null : null;

  // Reset the playhead when the lap being replayed changes.
  useEffect(() => {
    setT(0);
  }, [primaryNum]);

  useEffect(() => {
    if (!playing || !primary) return;
    let raf = 0;
    let last = performance.now();
    const total = primary.totalTime;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt * rate;
        return next >= total ? next % total : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, primary]);

  const geom = useTrackGeometry(primary ? primary.frames : []);

  const maxSteer = useMemo(() => {
    if (!primary) return 1;
    let m = 1;
    for (const f of primary.frames) m = Math.max(m, Math.abs(f.steer));
    return m;
  }, [primary]);

  const maxRpm = useMemo(() => {
    if (!primary) return 1;
    let m = 1;
    for (const f of primary.frames) m = Math.max(m, f.rpm);
    return m;
  }, [primary]);

  if (!primary) {
    return (
      <Panel title="Lap replay" style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: MONO, fontSize: 12, color: "#5B6572" }}>
          No frame data on this session to replay.
        </div>
      </Panel>
    );
  }

  const cur = sampleAtTime(primary, t);
  const ghostCur = ghost ? sampleAtTime(ghost, t) : null;
  const maxDist = Math.max(primary.totalDist, ghost ? ghost.totalDist : 0) || 1;

  // Gap at the car's current position: how much later (+) or earlier (-) the
  // primary lap is than the ghost lap at this same point on track.
  const gap = ghost ? t - timeAtDist(ghost, cur.dist) : null;

  const [cx, cy] = geom.project(cur.x, cur.y);
  const ghostPos = ghostCur ? geom.project(ghostCur.x, ghostCur.y) : null;
  const drivenPts = geom.pts.slice(0, Math.max(2, Math.ceil((cur.dist / (primary.totalDist || 1)) * geom.pts.length)));

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Controls */}
      <Panel title="Lap replay" subtitle="time is reconstructed from distance and speed" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <button
            onClick={() => setPlaying((p) => !p)}
            style={{ ...selectStyle, background: PRIMARY, color: "#0B0E11", border: "none", fontWeight: 700, minWidth: 74 }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => { setPlaying(false); setT(0); }} style={selectStyle}>
            Restart
          </button>
          <label style={{ fontFamily: MONO, fontSize: 11, color: "#5B6572" }}>
            Lap{" "}
            <select value={primaryNum} onChange={(e) => setPrimaryNum(Number(e.target.value))} style={selectStyle}>
              {lapNums.map((n) => (
                <option key={n} value={n}>
                  L{n} · {fmtTime(prepared.get(n)!.lapTime)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontFamily: MONO, fontSize: 11, color: "#5B6572" }}>
            Ghost{" "}
            <select
              value={ghostNum ?? ""}
              onChange={(e) => setGhostNum(e.target.value === "" ? null : Number(e.target.value))}
              style={selectStyle}
            >
              <option value="">None</option>
              {lapNums.filter((n) => n !== primaryNum).map((n) => (
                <option key={n} value={n}>
                  L{n} · {fmtTime(prepared.get(n)!.lapTime)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontFamily: MONO, fontSize: 11, color: "#5B6572" }}>
            Speed{" "}
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))} style={selectStyle}>
              {RATES.map((r) => (
                <option key={r} value={r}>{r}x</option>
              ))}
            </select>
          </label>
          {gap != null && (
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: gap > 0 ? "#FF5C77" : "#00C853" }}>
              {gap > 0 ? "+" : ""}{gap.toFixed(3)}s vs L{ghost!.lapNum}
            </div>
          )}
        </div>
        <input
          type="range"
          min={0}
          max={primary.totalTime}
          step={0.01}
          value={Math.min(t, primary.totalTime)}
          onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, color: "#5B6572", marginTop: 4 }}>
          <span>{fmtTime(t)}</span>
          <span>{Math.round(cur.dist)} m</span>
          <span>{fmtTime(primary.totalTime)}</span>
        </div>
      </Panel>

      {/* Map + live gauges */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 14 }}>
        <Panel title="Track" subtitle={`L${primary.lapNum}${ghost ? ` vs L${ghost.lapNum}` : ""}`}>
          <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} style={{ width: "100%", height: "auto", background: "#0B0E11", borderRadius: 4, display: "block" }}>
            <polyline points={geom.pts.join(" ")} fill="none" stroke="#262B33" strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={drivenPts.join(" ")} fill="none" stroke={PRIMARY} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
            {ghostPos && <circle cx={ghostPos[0]} cy={ghostPos[1]} r={6} fill={GHOST} stroke="#0B0E11" strokeWidth={2} />}
            <circle cx={cx} cy={cy} r={7} fill={PRIMARY} stroke="#0B0E11" strokeWidth={2} />
          </svg>
        </Panel>

        <Panel title="Live" subtitle={`L${primary.lapNum}`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
            <Stat label="Speed" value={`${Math.round(cur.speed)} km/h`} color={PRIMARY} />
            <Stat label="Gear" value={cur.gear <= 0 ? (cur.gear === 0 ? "N" : "R") : String(cur.gear)} />
            <Stat label="DRS" value={cur.drs ? "OPEN" : "closed"} color={cur.drs ? "#00C853" : "#5B6572"} />
            <Stat label="RPM" value={String(Math.round(cur.rpm))} />
            <Stat label="Lat G" value={cur.gLat.toFixed(2)} />
            <Stat label="Lon G" value={cur.gLon.toFixed(2)} />
            <Stat label="ERS" value={cur.ers.toFixed(0)} />
            <Stat label="Fuel" value={cur.fuel.toFixed(2)} />
            <Stat label="Engine" value={`${Math.round(cur.engineTemp)}°C`} />
          </div>
          <Bar label="Throttle" value={cur.throttle} max={1} color="#00C853" />
          <Bar label="Brake" value={cur.brake} max={1} color="#FF5C77" />
          <Bar label="RPM" value={cur.rpm} max={maxRpm} color="#9B5DE5" />
          <div style={{ marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10, color: "#5B6572", marginBottom: 3 }}>
              <span>Steering</span>
              <span style={{ color: "#E7EAEE" }}>{Math.round(cur.steer)}°</span>
            </div>
            <div style={{ position: "relative", height: 8, background: "#0B0E11", borderRadius: 4 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: 8, background: "#262B33" }} />
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  height: 8,
                  background: "#FFC400",
                  borderRadius: 4,
                  left: `${50 + Math.max(-1, Math.min(1, cur.steer / maxSteer)) * 50}%`,
                  width: 6,
                  transform: "translateX(-3px)",
                }}
              />
            </div>
          </div>
        </Panel>

        <Panel title="Tyres & brakes" subtitle="surface / inner °C · psi · wear %">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["FL", "FR", "RL", "RR"] as Corner[]).map((c) => (
              <div key={c} style={{ background: "#0B0E11", borderRadius: 6, padding: 8, borderLeft: `3px solid ${CORNER_COLORS[c]}` }}>
                <div style={{ fontFamily: MONO, fontSize: 10, color: CORNER_COLORS[c], marginBottom: 4 }}>{c}</div>
                <div style={{ fontFamily: MONO, fontSize: 12 }}>
                  {Math.round(cur.tyreTemp[c])} / {Math.round(cur.tyreTempInner[c])}°C
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#9AA3AF", marginTop: 2 }}>
                  {cur.tyrePressure[c].toFixed(1)} psi · {cur.tyreWear[c].toFixed(1)}%
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#FF5C77", marginTop: 2 }}>
                  brake {Math.round(cur.brakeTemp[c])}°C
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* Every channel, synced to the playhead */}
      {GROUPS.map((g) => (
        <details key={g.title} open style={{ marginBottom: 14 }}>
          <summary style={{ cursor: "pointer", fontFamily: "'Titillium Web', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9AA3AF", marginBottom: 8 }}>
            {g.title}
          </summary>
          <Panel title="Trace vs distance" subtitle={ghost ? `cyan = L${primary.lapNum}, amber = L${ghost.lapNum}` : `L${primary.lapNum} · distance on x axis`}>
            {g.channels.map((ch) => (
              <Trace key={ch.id} channel={ch} primary={primary} ghost={ghost} maxDist={maxDist} cur={cur} ghostCur={ghostCur} />
            ))}
          </Panel>
        </details>
      ))}
    </div>
  );
}
