import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// UDP SessionType (F1 23-25) -> telemetry_sessions.session_type
function sessionType(n: number): string {
  if (n >= 1 && n <= 4) return "practice";
  if (n >= 5 && n <= 14) return "qualifying";
  if (n >= 15 && n <= 17) return "race";
  if (n === 18) return "time_trial";
  return "practice";
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const int = (v: unknown, max = 3_600_000) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
const dec = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

function authorised(req: NextRequest): boolean {
  const want = process.env.TELEMETRY_INGEST_SECRET;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Forwarder polls this to know which per-driver UDP ports to listen on.
export async function GET(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await createAdminClient().schema("pitboss").from("telemetry_tokens")
    .select("udp_port").not("udp_port", "is", null).is("revoked_at", null);
  if (error) return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  return NextResponse.json({ ports: (data ?? []).map((r: any) => r.udp_port) });
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const events: any[] = Array.isArray(body?.events) ? body.events.slice(0, 500) : [];
  if (!events.length) return NextResponse.json({ ok: true, accepted: 0, rejectedTokens: [], rejectedPorts: [] });

  const db = createAdminClient().schema("pitboss");
  const ids = events.map((e) => e?.id).filter(Boolean);
  const tokens = [...new Set(ids.map((i) => (typeof i.token === "string" ? i.token : "")).filter(Boolean))];
  const ports = [...new Set(ids.map((i) => i.port).filter((p) => Number.isInteger(p)))] as number[];
  const found: any[] = [];
  if (tokens.length) {
    const r = await db.from("telemetry_tokens").select("token_hash, udp_port, driver_id, league_id").in("token_hash", tokens.map(sha)).is("revoked_at", null);
    if (r.error) { console.error("[telemetry/ingest] token lookup failed"); return NextResponse.json({ error: "lookup failed" }, { status: 500 }); }
    found.push(...(r.data ?? []));
  }
  if (ports.length) {
    const r = await db.from("telemetry_tokens").select("token_hash, udp_port, driver_id, league_id").in("udp_port", ports).is("revoked_at", null);
    if (r.error) { console.error("[telemetry/ingest] port lookup failed"); return NextResponse.json({ error: "lookup failed" }, { status: 500 }); }
    found.push(...(r.data ?? []));
  }
  const byHash = new Map(found.filter((r) => r.token_hash).map((r) => [r.token_hash, r]));
  const byPort = new Map(found.filter((r) => r.udp_port).map((r) => [r.udp_port, r]));
  const resolve = (i: any) => (typeof i?.token === "string" ? byHash.get(sha(i.token)) : Number.isInteger(i?.port) ? byPort.get(i.port) : undefined);
  const rejectedTokens = tokens.filter((t) => !byHash.has(sha(t)));
  const rejectedPorts = ports.filter((p) => !byPort.has(p));
  const sessionIds = new Map<string, string | null>();
  let accepted = 0;

  async function sessionId(driverId: string, leagueId: string | null, e: any, create: boolean) {
    const key = `${driverId}:${e.sessionUid}`;
    const cached = sessionIds.get(key);
    if (cached) return cached;
    const find = () => db.from("telemetry_sessions").select("id").eq("driver_id", driverId).eq("session_uid", String(e.sessionUid)).maybeSingle();
    let id: string | null = (await find()).data?.id ?? null;
    if (!id && create) {
      const ins = await db.from("telemetry_sessions").insert({
        driver_id: driverId, league_id: leagueId, game: "f1", game_version: `f1_${int(e.year, 99) ?? 25}`,
        session_type: sessionType(Number(e.sessionType)), track: `udp_track_${int(e.trackId, 255) ?? "unknown"}`,
        source: "live_udp", status: "active", started_at: new Date().toISOString(), session_uid: String(e.sessionUid),
      }).select("id").single();
      id = ins.data?.id ?? (await find()).data?.id ?? null; // lost a race on the unique index
    }
    if (id) sessionIds.set(key, id); // never cache a miss
    return id;
  }

  for (const e of events) {
    const t = resolve(e?.id) as any;
    if (!t || !e?.sessionUid) continue;
    try {
      if (e.type === "session") {
        if (await sessionId(t.driver_id, t.league_id, e, true)) accepted++;
      } else if (e.type === "lap") {
        const sid = await sessionId(t.driver_id, t.league_id, e, false);
        const n = int(e.lapNumber, 500);
        if (!sid || !n) continue;
        const { error: le } = await db.from("telemetry_laps").upsert({
          session_id: sid, lap_number: n, lap_time_ms: int(e.lapTimeMs), sector_1_ms: int(e.s1), sector_2_ms: int(e.s2), sector_3_ms: int(e.s3),
          valid: e.valid !== false, tyre_compound: typeof e.compound === "string" ? e.compound.slice(0, 20) : null,
          fuel_remaining_kg: dec(e.fuelKg, 200), top_speed_kph: dec(e.topSpeedKph, 500),
        }, { onConflict: "session_id,lap_number" });
        if (!le) accepted++;
      } else if (e.type === "end") {
        const sid = await sessionId(t.driver_id, t.league_id, e, false);
        if (sid) { await db.from("telemetry_sessions").update({ status: "completed", ended_at: new Date().toISOString() }).eq("id", sid); accepted++; }
      }
    } catch { console.error("[telemetry/ingest] event failed", e?.type); }
  }
  return NextResponse.json({ ok: true, accepted, rejectedTokens, rejectedPorts });
}
