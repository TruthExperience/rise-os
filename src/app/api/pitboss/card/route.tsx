// FILE: src/app/api/pitboss/card/route.tsx   (new file)
// Renders a results / standings card as a PNG, styled like the app's
// results and standings pages. The Discord bot attaches these to its posts.
// Public (all of /api skips the login redirect) but every URL must carry a
// valid signature from src/lib/discord/card-url.ts.
import { ImageResponse } from "next/og";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyCard, type CardKind } from "@/lib/discord/card-url";
import { loadDriverLabels, labelFull } from "@/lib/discord/driver-labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const W = 1000;
const ROW = 64;
const MAX_ROWS = 40;
const KINDS: CardKind[] = ["race", "quali", "drivers", "teams"];

type Line = { pos: string; name: string; sub: string; right: string };

const num = (v: unknown) => String(Number(v ?? 0));

const fmtLap = (s: unknown) => {
  if (s == null) return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return "";
  const m = Math.floor(n / 60);
  return `${m}:${(n - m * 60).toFixed(3).padStart(6, "0")}`;
};
const fmtRace = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};
// Winner shows total time; everyone else shows the gap to the winner.
const raceTimeLabel = (r: any, winnerTime: number | null) => {
  if (r.dnf || r.race_time_seconds == null) return "";
  const t = Number(r.race_time_seconds);
  if (winnerTime == null || t === winnerTime) return fmtRace(t);
  return `+${(t - winnerTime).toFixed(3)}`;
};

async function logoData(url?: string | null): Promise<string | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!/^image\/(png|jpe?g|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1_500_000) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") as CardKind | null;
  const leagueId = sp.get("league_id");
  const season = sp.get("season");
  const roundRaw = sp.get("round");

  if (!kind || !KINDS.includes(kind) || !leagueId || !season) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const params = { kind, league_id: leagueId, season, round: roundRaw };
  if (!verifyCard(params, sp.get("sig"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = createAdminClient();
  const pb = supabase.schema("pitboss");
  const { data: league } = await pb.from("leagues").select("name, logo_url").eq("id", leagueId).single();

  let lines: Line[] = [];
  let title = "";
  let subtitle = "";

  if (kind === "race" || kind === "quali") {
    const roundNum = Number(roundRaw);
    if (!Number.isInteger(roundNum)) return NextResponse.json({ error: "Bad round" }, { status: 400 });
    const { data: rows } = await pb
      .from("results_with_team")
      .select("driver_id, team_id, track, qualifying_position, finish_position, dnf, fastest_lap, points_earned, quali_time_seconds, race_time_seconds")
      .eq("league_id", leagueId)
      .eq("season", season)
      .eq("round", roundNum)
      .limit(500);
    const ids = [...new Set((rows ?? []).map((r: any) => r.driver_id))];
    const labels = await loadDriverLabels(pb, leagueId, ids as string[]);
    const names = Object.fromEntries(Object.entries(labels).map(([id, l]) => [id, labelFull(l)]));
    const track = (rows ?? []).find((r: any) => r.track)?.track;
    title = kind === "race" ? "RACE RESULTS" : "QUALIFYING";
    subtitle = `Season ${season} · Round ${roundNum}${track ? ` · ${track}` : ""}`;

    const list = [...(rows ?? [])]
      .filter((r: any) => (kind === "race" ? true : r.qualifying_position != null))
      .sort((a: any, b: any) => {
        if (kind === "quali") return a.qualifying_position - b.qualifying_position;
        if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
        return (a.finish_position ?? 999) - (b.finish_position ?? 999);
      });
    const poleTime = list.find((r: any) => r.qualifying_position === 1)?.quali_time_seconds;
    const winner = list.find((r: any) => !r.dnf && r.race_time_seconds != null);
    const winnerTime = winner ? Number(winner.race_time_seconds) : null;
    lines = list.map((r: any, i: number) =>
      kind === "quali"
        ? {
            pos: String(r.qualifying_position),
            name: names[r.driver_id] ?? "Unknown",
            sub:
              r.quali_time_seconds != null && poleTime != null && r.qualifying_position !== 1
                ? `+${(Number(r.quali_time_seconds) - Number(poleTime)).toFixed(3)}`
                : "",
            right: fmtLap(r.quali_time_seconds),
          }
        : {
            pos: r.dnf ? "DNF" : String(r.finish_position ?? i + 1),
            name: names[r.driver_id] ?? "Unknown",
            sub: [
              r.qualifying_position != null ? `Q${r.qualifying_position}` : "",
              r.fastest_lap ? "FL" : "",
              raceTimeLabel(r, winnerTime),
            ]
              .filter(Boolean)
              .join(" · "),
            right: num(r.points_earned),
          }
    );
  } else {
    const byPoints = (a: any, b: any) =>
      Number(b.points) - Number(a.points) || b.wins - a.wins || b.top3 - a.top3;
    if (kind === "drivers") {
      const { data: live } = await pb
        .from("driver_standings_live")
        .select("driver_id, wins, top3, points")
        .eq("league_id", leagueId)
        .eq("season", season);
      const ids = (live ?? []).map((r: any) => r.driver_id);
      const labels = await loadDriverLabels(pb, leagueId, ids as string[]);
      const names = Object.fromEntries(Object.entries(labels).map(([id, l]) => [id, labelFull(l)]));
      title = "DRIVERS' CHAMPIONSHIP";
      lines = [...(live ?? [])].sort(byPoints).map((r: any, i: number) => ({
        pos: String(i + 1),
        name: names[r.driver_id] ?? "Unknown",
        sub: `${r.wins} win${r.wins === 1 ? "" : "s"}`,
        right: num(r.points),
      }));
    } else {
      const { data: live } = await pb
        .from("constructor_standings_live")
        .select("franchise_id, wins, top3, points")
        .eq("league_id", leagueId)
        .eq("season", season);
      const ids = (live ?? []).map((r: any) => r.franchise_id);
      const { data: teams } = ids.length
        ? await supabase.schema("rise_os").from("franchises").select("id, name").in("id", ids)
        : { data: [] as any[] };
      const names = Object.fromEntries((teams ?? []).map((t: any) => [t.id, t.name]));
      title = "CONSTRUCTORS' CHAMPIONSHIP";
      lines = [...(live ?? [])].sort(byPoints).map((r: any, i: number) => ({
        pos: String(i + 1),
        name: names[r.franchise_id] ?? "Unknown team",
        sub: `${r.wins} win${r.wins === 1 ? "" : "s"}`,
        right: num(r.points),
      }));
    }
    subtitle = `Season ${season}`;
  }

  const shown = lines.slice(0, MAX_ROWS);
  const hidden = lines.length - shown.length;
  const logo = await logoData(league?.logo_url);
  const headH = 200;
  const bodyH = Math.max(shown.length, 1) * ROW + (hidden > 0 ? 40 : 0);
  const height = headH + bodyH + 40;

  return new ImageResponse(
    (
      <div
        style={{
          width: W,
          height,
          display: "flex",
          flexDirection: "column",
          background: "#07070b",
          color: "#ffffff",
          padding: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", height: 144, marginBottom: 28 }}>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} width={112} height={112} style={{ borderRadius: 56, marginRight: 28 }} />
          ) : null}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 40, fontWeight: 800 }}>{league?.name ?? "League"}</div>
            <div style={{ display: "flex", fontSize: 22, color: "#e8284a", letterSpacing: 2, marginTop: 8 }}>
              {title}
            </div>
            <div style={{ display: "flex", fontSize: 20, color: "rgba(255,255,255,0.45)", marginTop: 6 }}>
              {subtitle}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 20,
            overflow: "hidden",
          }}
        >
          {shown.length === 0 ? (
            <div style={{ display: "flex", height: ROW, alignItems: "center", padding: "0 24px", fontSize: 22, color: "rgba(255,255,255,0.5)" }}>
              No results yet.
            </div>
          ) : (
            shown.map((l, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: ROW,
                  padding: "0 24px",
                  background: i % 2 === 0 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)",
                  borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    width: 72,
                    fontSize: 26,
                    fontWeight: 800,
                    color: l.pos === "1" ? "#e8284a" : "rgba(255,255,255,0.55)",
                  }}
                >
                  {l.pos}
                </div>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", paddingRight: 16 }}>
                  <div style={{ display: "flex", fontSize: 25, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {l.name}
                  </div>
                  {l.sub ? (
                    <div style={{ display: "flex", fontSize: 17, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                      {l.sub}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", fontSize: 30, fontWeight: 800 }}>{l.right}</div>
              </div>
            ))
          )}
          {hidden > 0 ? (
            <div style={{ display: "flex", height: 40, alignItems: "center", padding: "0 24px", fontSize: 18, color: "rgba(255,255,255,0.4)" }}>
              +{hidden} more
            </div>
          ) : null}
        </div>
      </div>
    ),
    {
      width: W,
      height,
      headers: { "Cache-Control": "public, max-age=300" },
    }
  );
}
