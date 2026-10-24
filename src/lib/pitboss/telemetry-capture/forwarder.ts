/**
 * PitBoss — UDP telemetry forwarder (runs on the Oracle origin VPS, NOT on Vercel).
 *
 * Receives F1 UDP packets, derives session + completed-lap events for the PLAYER
 * car, and POSTs them in batches to /api/pitboss/telemetry/ingest.
 *
 *   :30000-39999  one UDP port PER DRIVER (PS5 / Xbox / PC) -> the port identifies the driver.
 *   :20778        PC relay packets  -> "PBT1" | tokenLen(u8) | token | raw packet
 *   :20777        optional raw port -> driver resolved via IP_TOKEN_MAP
 *
 * Run: tsx src/lib/pitboss/telemetry-capture/forwarder.ts
 */
import dgram from 'node:dgram';
import { parsePacket } from './parser';
import { HEADER_SIZE_BYTES } from './header';

const RAW_PORT = Number(process.env.PITBOSS_UDP_PORT ?? 20777);
const RELAY_PORT = Number(process.env.PITBOSS_RELAY_PORT ?? 20778);
const INGEST_URL = process.env.INGEST_URL ?? '';
const INGEST_SECRET = process.env.INGEST_SECRET ?? '';
const IP_TOKEN_MAP: Record<string, string> = safeJson(process.env.IP_TOKEN_MAP) ?? {};
if (!INGEST_URL || !INGEST_SECRET) { console.error('INGEST_URL and INGEST_SECRET are required'); process.exit(1); }

const MAX_SOURCES = 500, MAX_QUEUE = 5000, BATCH = 100, FLUSH_MS = 2000, IDLE_END_MS = 90_000, BLOCK_MS = 10 * 60_000;
const COMPOUND: Record<number, string> = { 16: 'soft', 17: 'medium', 18: 'hard', 7: 'inter', 8: 'wet' };

// Same table as listener.ts — rejects packets whose length doesn't match the declared type.
const SIZES: Record<number, Record<string, number>> = {
  23: { session: 644, lapData: 1131, carTelemetry: 1352, carStatus: 1239 },
  24: { session: 753, lapData: 1285, carTelemetry: 1352, carStatus: 1239 },
  25: { session: 753, lapData: 1285, carTelemetry: 1352, carStatus: 1239 },
  26: { session: 926, lapData: 1399, carTelemetry: 1448, carStatus: 1445 },
};

type Id = { token: string } | { port: number };
const keyOf = (i: Id) => ('token' in i ? `t:${i.token}` : `p:${i.port}`);
type Ev =
  | { type: 'session'; id: Id; sessionUid: string; year: number; sessionType: number; trackId: number }
  | { type: 'lap'; id: Id; sessionUid: string; lapNumber: number; lapTimeMs: number | null; s1: number | null; s2: number | null; s3: number | null; valid: boolean; compound: string | null; fuelKg: number | null; topSpeedKph: number | null }
  | { type: 'end'; id: Id; sessionUid: string };

interface Src {
  ip: string; sessionUid: string; sessionSent: boolean; pendingLaps: Ev[];
  lapNum: number; s1: number; s2: number; invalid: boolean; topSpeed: number;
  fuel: number | null; compound: string | null; lastSeen: number;
}
const sources = new Map<string, Src>();
const blocked = new Map<string, number>(); // key -> blocked-until
let queue: Ev[] = [];
const stats = { rx: 0, bad: 0, sent: 0, dropped: 0 };

function safeJson(s?: string) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
const ms = (part?: number, min?: number) => (part ?? 0) + (min ?? 0) * 60_000;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function push(e: Ev) { queue.push(e); if (queue.length > MAX_QUEUE) { queue.shift(); stats.dropped++; } }

function handle(id: Id, ip: string, buf: Buffer) {
  const key = keyOf(id);
  if ((blocked.get(key) ?? 0) > Date.now()) return;
  if (buf.length < HEADER_SIZE_BYTES) { stats.bad++; return; }
  let p: any;
  try { p = parsePacket(buf); } catch { stats.bad++; return; }
  if (!p) return;
  const want = SIZES[p.year]?.[p.kind];
  if (want !== undefined && want !== buf.length) { stats.bad++; return; }
  if (!['session', 'lapData', 'carTelemetry', 'carStatus'].includes(p.kind)) return;

  const h = p.data.header, uid = String(h.sessionUid), idx = h.playerCarIndex;
  if (idx == null || idx < 0 || idx > 21) return;

  let s = sources.get(key);
  // While a session is live, ignore other IPs sending to the same port/token (blocks mid-session hijack).
  if (s && s.ip !== ip && Date.now() - s.lastSeen < IDLE_END_MS) return;
  if (s && s.sessionUid !== uid) { if (s.sessionSent) push({ type: 'end', id, sessionUid: s.sessionUid }); sources.delete(key); s = undefined; }
  if (!s) {
    if (sources.size >= MAX_SOURCES) return;
    s = { ip, sessionUid: uid, sessionSent: false, pendingLaps: [], lapNum: 0, s1: 0, s2: 0, invalid: false, topSpeed: 0, fuel: null, compound: null, lastSeen: 0 };
    sources.set(key, s);
  }
  s.lastSeen = Date.now();

  if (p.kind === 'session' && !s.sessionSent) {
    s.sessionSent = true;
    push({ type: 'session', id, sessionUid: uid, year: p.year, sessionType: p.data.sessionType, trackId: p.data.trackId });
    for (const l of s.pendingLaps) push(l);
    s.pendingLaps = [];
  } else if (p.kind === 'carTelemetry') {
    const sp = num(p.data.carTelemetryData?.[idx]?.speed); if (sp !== null && sp > s.topSpeed) s.topSpeed = sp;
  } else if (p.kind === 'carStatus') {
    const c = p.data.carStatusData?.[idx]; if (c) { s.fuel = num(c.fuelInTank); s.compound = COMPOUND[c.visualTyreCompound] ?? null; }
  } else if (p.kind === 'lapData') {
    const ld = p.data.lapData?.[idx]; if (!ld) return;
    const cur: number = ld.currentLapNum;
    if (s.lapNum > 0 && cur > s.lapNum) {
      const last = ld.lastLapTimeInMS > 0 ? ld.lastLapTimeInMS : null;
      const s3 = last !== null && s.s1 > 0 && s.s2 > 0 ? last - s.s1 - s.s2 : null;
      const lap: Ev = { type: 'lap', id, sessionUid: uid, lapNumber: s.lapNum, lapTimeMs: last, s1: s.s1 || null, s2: s.s2 || null,
        s3: s3 !== null && s3 > 0 ? s3 : null, valid: !s.invalid, compound: s.compound, fuelKg: s.fuel, topSpeedKph: s.topSpeed || null };
      s.sessionSent ? push(lap) : s.pendingLaps.push(lap);
      s.s1 = s.s2 = 0; s.invalid = false; s.topSpeed = 0;
    }
    s.lapNum = cur;
    const a = ld.sector1TimeMSPart !== undefined ? ms(ld.sector1TimeMSPart, ld.sector1TimeMinutesPart) : ms(ld.sector1TimeInMS, ld.sector1TimeMinutes);
    const b = ld.sector2TimeMSPart !== undefined ? ms(ld.sector2TimeMSPart, ld.sector2TimeMinutesPart) : ms(ld.sector2TimeInMS, ld.sector2TimeMinutes);
    if (a > 0) s.s1 = a; if (b > 0) s.s2 = b;
    if (ld.currentLapInvalid === 1) s.invalid = true;
  }
}

// ---- sockets ----
function bind(port: number, onMsg: (m: Buffer, ip: string) => void): dgram.Socket {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (m, r) => { stats.rx++; onMsg(m, r.address); });
  sock.on('error', (e) => console.error(`[fwd] socket ${port}`, e));
  sock.bind(port, () => { if (port < 30000) console.log(`[fwd] listening UDP ${port}`); });
  return sock;
}
bind(RAW_PORT, (m, ip) => { const t = IP_TOKEN_MAP[ip]; if (t) handle({ token: t }, ip, m); });
bind(RELAY_PORT, (m, ip) => {
  if (m.length < 6 || m.toString('latin1', 0, 4) !== 'PBT1') return;
  const n = m[4]; if (m.length < 5 + n + HEADER_SIZE_BYTES) return;
  handle({ token: m.toString('utf8', 5, 5 + n) }, ip, m.subarray(5 + n));
});

// Per-driver ports: open/close sockets to match the assignments held in Supabase.
const portSockets = new Map<number, dgram.Socket>();
async function syncPorts() {
  try {
    const res = await fetch(INGEST_URL, { headers: { authorization: `Bearer ${INGEST_SECRET}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const want = new Set<number>(((await res.json()) as any).ports ?? []);
    for (const port of want) if (!portSockets.has(port) && port >= 30000 && port <= 39999) portSockets.set(port, bind(port, (m, ip) => handle({ port }, ip, m)));
    for (const [port, sock] of portSockets) if (!want.has(port)) { sock.close(); portSockets.delete(port); }
  } catch (e) { console.warn('[fwd] port sync failed:', (e as Error).message); }
}
syncPorts(); setInterval(syncPorts, 60_000);

// ---- shipping ----
let inflight = false;
async function flush() {
  if (inflight || queue.length === 0) return;
  inflight = true;
  const batch = queue.splice(0, BATCH);
  try {
    const res = await fetch(INGEST_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_SECRET}` }, body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json().catch(() => ({}));
    for (const t of j.rejectedTokens ?? []) blocked.set(`t:${t}`, Date.now() + BLOCK_MS);
    for (const p of j.rejectedPorts ?? []) blocked.set(`p:${p}`, Date.now() + BLOCK_MS);
    stats.sent += batch.length;
  } catch (e) {
    queue = batch.concat(queue).slice(-MAX_QUEUE); // retry later, oldest dropped past cap
    console.warn('[fwd] ingest failed, will retry:', (e as Error).message);
  } finally { inflight = false; }
}
setInterval(flush, FLUSH_MS);
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sources) if (now - s.lastSeen > IDLE_END_MS) {
    if (s.sessionSent) push({ type: 'end', id: k.startsWith('p:') ? { port: Number(k.slice(2)) } : { token: k.slice(2) }, sessionUid: s.sessionUid });
    sources.delete(k);
  }
  for (const [t, until] of blocked) if (until < now) blocked.delete(t);
}, 15_000);
setInterval(() => console.log(`[fwd] rx=${stats.rx} bad=${stats.bad} sent=${stats.sent} dropped=${stats.dropped} queued=${queue.length} sources=${sources.size} ports=${portSockets.size}`), 30_000);
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
