// FILE: src/lib/discord/standings-post.ts   (new file)
// Keeps one "driver standings" and one "team standings" message per league
// up to date in Discord. Channels live in pitboss.standings_discord_sync
// (one row per league); leagues without a row are skipped. The message is
// edited in place (not re-posted) and nothing is sent when results haven't
// changed since the last sync, so it is cheap to call after any standings
// change. Never throws.
import { createAdminClient } from "@/lib/supabase/server";
import { buildCardUrl } from "@/lib/discord/card-url";
import { loadDriverLabels, labelPlain, type DriverLabel } from "@/lib/discord/driver-labels";

const API = "https://discord.com/api/v10";
const MAX_DESC = 3900;

type Row = { name: string; wins: number; points: number; flag?: string | null };

// League logo shown in the top-left of each embed (needs a public https URL).
function authorOf(league: any) {
  const url = league?.logo_url;
  return url && /^https?:\/\//.test(url) ? { name: league?.name ?? "League", icon_url: url } : undefined;
}

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

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function table(rows: Row[]) {
  const w = Math.min(22, Math.max(8, ...rows.map((r) => r.name.length)));
  const lines = rows.map((r, i) => {
    const pos = String(i + 1).padStart(2, " ");
    const pts = String(Number(r.points)).padStart(4, " ");
    const wins = String(r.wins).padStart(2, " ");
    return `${pos}  ${pad(r.name, w)}  ${wins}W ${pts}${r.flag ? `  ${r.flag}` : ""}`;
  });
  let body = "```\n" + lines.join("\n") + "\n```";
  while (body.length > MAX_DESC && lines.length > 1) {
    lines.pop();
    body = "```\n" + lines.join("\n") + "\n```";
  }
  return body;
}

// Standings embed body: the app-styled card image when the card URL can be
// built (needs NEXT_PUBLIC_APP_URL and PITBOSS_INTERNAL_KEY), otherwise the
// plain text table.
function standingsBody(rows: Row[], imageUrl: string | null) {
  return imageUrl
    ? { image: { url: imageUrl } }
    : { description: rows.length ? table(rows) : "No results yet." };
}

async function send(token: string, channelId: string, messageId: string | null, payload: object) {
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  if (messageId) {
    const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.ok) return messageId;
    if (res.status !== 404) {
      console.error("[standings-post] edit failed", res.status, await res.text());
      return messageId;
    }
    // Message was deleted: fall through and post a fresh one.
  }
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("[standings-post] post failed", res.status, await res.text());
    return messageId;
  }
  const msg = await res.json();
  return (msg.id as string) ?? messageId;
}

export async function syncStandingsToDiscord(leagueId: string, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
    if (!token) return;

    const supabase = createAdminClient();
    const pb = supabase.schema("pitboss");

    const { data: cfg } = await pb
      .from("standings_discord_sync")
      .select("*")
      .eq("league_id", leagueId)
      .maybeSingle();
    if (!cfg || (!cfg.driver_channel_id && !cfg.team_channel_id)) return;

    const { data: seasonRows } = await pb
      .from("results_last_change")
      .select("season, last_change, row_count")
      .eq("league_id", leagueId);
    const sorted = [...(seasonRows ?? [])].sort((a: any, b: any) => {
      const na = Number(a.season), nb = Number(b.season);
      return Number.isNaN(na) || Number.isNaN(nb) ? String(b.season).localeCompare(String(a.season)) : nb - na;
    });
    const latest: any = sorted[0];
    if (!latest) return;
    const season = String(latest.season);
    const version = `${season}:${latest.row_count}:${latest.last_change}`;
    if (!opts.force && cfg.last_version === version) return;

    const { data: league } = await pb.from("leagues").select("name, logo_url").eq("id", leagueId).single();
    const { data: roundRows } = await pb
      .from("results")
      .select("round")
      .eq("league_id", leagueId)
      .eq("season", season)
      .limit(5000);
    const lastRound = Math.max(0, ...(roundRows ?? []).map((r: any) => Number(r.round) || 0));
    const footer = {
      text: `Season ${season}${lastRound ? ` · after round ${lastRound}` : ""}`,
    };
    const byPoints = (a: any, b: any) =>
      Number(b.points) - Number(a.points) || b.wins - a.wins || b.top3 - a.top3;

    let driverMsg: string | null = cfg.driver_message_id ?? null;
    let teamMsg: string | null = cfg.team_message_id ?? null;

    if (cfg.driver_channel_id) {
      const { data: live } = await pb
        .from("driver_standings_live")
        .select("driver_id, wins, top3, points")
        .eq("league_id", leagueId)
        .eq("season", season);
      const ids = (live ?? []).map((r: any) => r.driver_id);
      const labels: Record<string, DriverLabel> = await loadDriverLabels(pb, leagueId, ids as string[]);
      const rows: Row[] = [...(live ?? [])]
        .sort(byPoints)
        .map((r: any) => ({
          name: labelPlain(labels[r.driver_id]),
          flag: labels[r.driver_id]?.flag ?? null,
          wins: r.wins,
          points: r.points,
        }));
      driverMsg = await send(token, cfg.driver_channel_id, driverMsg, {
        embeds: [
          {
            author: authorOf(league),
            title: `${league?.name ?? "League"} — Drivers' Championship`,
            ...standingsBody(rows, buildCardUrl({ kind: "drivers", league_id: leagueId, season })),
            color: 0xe8284a,
            footer,
            timestamp: new Date().toISOString(),
          },
        ],
        allowed_mentions: { parse: [] },
      });
    }

    if (cfg.team_channel_id) {
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
      const rows: Row[] = [...(live ?? [])]
        .sort(byPoints)
        .map((r: any) => ({ name: names[r.franchise_id] ?? "Unknown team", wins: r.wins, points: r.points }));
      teamMsg = await send(token, cfg.team_channel_id, teamMsg, {
        embeds: [
          {
            author: authorOf(league),
            title: `${league?.name ?? "League"} — Constructors' Championship`,
            ...standingsBody(rows, buildCardUrl({ kind: "teams", league_id: leagueId, season })),
            color: 0xe8284a,
            footer,
            timestamp: new Date().toISOString(),
          },
        ],
        allowed_mentions: { parse: [] },
      });
    }

    await pb
      .from("standings_discord_sync")
      .update({
        driver_message_id: driverMsg,
        team_message_id: teamMsg,
        last_version: version,
        updated_at: new Date().toISOString(),
      })
      .eq("league_id", leagueId);
  } catch (err) {
    console.error("[standings-post] sync failed", err);
  }
}

// ---------------------------------------------------------------------------
// Round results (race + qualifying) -> Discord
// Channels: standings_discord_sync.race_channel_id / quali_channel_id /
// stats_channel_id (full stats table).
// One message per round and kind, edited in place when results change
// (steward edit, penalty, appeal). Never throws.
// ---------------------------------------------------------------------------
export async function postRoundResultsToDiscord(
  leagueId: string,
  season: string | number,
  round: number | string
): Promise<void> {
  try {
    const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
    if (!token) return;
    const seasonKey = String(season);
    const roundNum = Number(round);
    if (!Number.isInteger(roundNum)) return;

    const supabase = createAdminClient();
    const pb = supabase.schema("pitboss");

    const { data: cfg } = await pb
      .from("standings_discord_sync")
      .select("race_channel_id, quali_channel_id, stats_channel_id")
      .eq("league_id", leagueId)
      .maybeSingle();
    if (!cfg || (!cfg.race_channel_id && !cfg.quali_channel_id && !cfg.stats_channel_id)) return;

    const { data: rows } = await pb
      .from("results_with_team")
      .select("driver_id, team_id, track, qualifying_position, finish_position, dnf, dnf_reason, fastest_lap, best_lap_seconds, points_earned, quali_time_seconds, race_time_seconds")
      .eq("league_id", leagueId)
      .eq("season", seasonKey)
      .eq("round", roundNum)
      .limit(500);
    if (!rows || rows.length === 0) return;

    const driverIds = [...new Set(rows.map((r: any) => r.driver_id))];
    const teamIds = [...new Set(rows.map((r: any) => r.team_id).filter(Boolean))];
    const [labels, { data: teams }, { data: league }] = await Promise.all([
      loadDriverLabels(pb, leagueId, driverIds as string[]),
      teamIds.length
        ? supabase.schema("rise_os").from("franchises").select("id, name").in("id", teamIds)
        : Promise.resolve({ data: [] as any[] }),
      pb.from("leagues").select("name, logo_url").eq("id", leagueId).single(),
    ]);
    const dName = Object.fromEntries(Object.entries(labels).map(([id, l]) => [id, labelPlain(l)]));
    const dFlag = Object.fromEntries(Object.entries(labels).map(([id, l]) => [id, l.flag ? `  ${l.flag}` : ""]));
    const tName = Object.fromEntries((teams ?? []).map((t: any) => [t.id, t.name]));
    const track = rows.find((r: any) => r.track)?.track ?? null;
    const heading = `${league?.name ?? "League"} — Season ${seasonKey}, Round ${roundNum}${track ? ` · ${track}` : ""}`;

    const build = (kind: "race" | "quali") => {
      const list = [...rows]
        .filter((r: any) => (kind === "race" ? true : r.qualifying_position != null))
        .sort((a: any, b: any) => {
          if (kind === "quali") return a.qualifying_position - b.qualifying_position;
          if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
          return (a.finish_position ?? 999) - (b.finish_position ?? 999);
        });
      const poleTime = list.find((r: any) => r.qualifying_position === 1)?.quali_time_seconds;
      const winner = list.find((r: any) => !r.dnf && r.race_time_seconds != null);
      const winnerTime = winner ? Number(winner.race_time_seconds) : null;
      const w = Math.min(20, Math.max(8, ...list.map((r: any) => (dName[r.driver_id] ?? "Unknown").length)));
      const lines = list.map((r: any, i: number) => {
        const name = pad(dName[r.driver_id] ?? "Unknown", w);
        const team = tName[r.team_id] ? `  ${tName[r.team_id]}` : "";
        if (kind === "quali") {
          const t = fmtLap(r.quali_time_seconds);
          return `${String(r.qualifying_position).padStart(2, " ")}  ${name}  ${t}${team}${dFlag[r.driver_id] ?? ""}`;
        }
        const pos = r.dnf ? "DNF" : String(r.finish_position ?? i + 1).padStart(3, " ");
        const fl = r.fastest_lap ? ` FL${fmtLap(r.best_lap_seconds) ? ` ${fmtLap(r.best_lap_seconds)}` : ""}` : "";
        return `${pos}  ${name}  ${String(Number(r.points_earned ?? 0)).padStart(3, " ")}pts  ${raceTimeLabel(r, winnerTime).padStart(10, " ")}${fl}${team}${dFlag[r.driver_id] ?? ""}`;
      });
      let body = "```\n" + lines.join("\n") + "\n```";
      while (body.length > MAX_DESC && lines.length > 1) {
        lines.pop();
        body = "```\n" + lines.join("\n") + "\n```";
      }
      return body;
    };


    // Full stats: one row per driver (finish, team, quali time + gap to pole,
    // race time/gap, fastest lap, points) plus constructor totals for the round
    // and the season. Plain text tables; no card image.
    const buildStats = async () => {
      const list = [...rows].sort((a: any, b: any) => {
        if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
        return (a.finish_position ?? 999) - (b.finish_position ?? 999);
      });
      const poleTime = rows
        .filter((r: any) => r.qualifying_position != null && r.quali_time_seconds != null)
        .sort((a: any, b: any) => a.qualifying_position - b.qualifying_position)[0]?.quali_time_seconds;
      const winner = list.find((r: any) => !r.dnf && r.race_time_seconds != null);
      const winnerTime = winner ? Number(winner.race_time_seconds) : null;
      const bestLap = Math.min(
        ...rows.filter((r: any) => r.best_lap_seconds != null).map((r: any) => Number(r.best_lap_seconds)),
        Infinity
      );
      const w = Math.min(14, Math.max(6, ...list.map((r: any) => (dName[r.driver_id] ?? "Unknown").length)));
      const tw = Math.min(12, Math.max(4, ...list.map((r: any) => (tName[r.team_id] ?? "").length)));
      const header = `${"P".padStart(3)} ${pad("Driver", w)} ${pad("Team", tw)} ${"Quali".padEnd(8)} ${"Gap".padEnd(7)} ${"Race".padEnd(9)} ${"FL".padEnd(8)} Pts`;
      const lines = list.map((r: any, i: number) => {
        const pos = r.dnf ? "DNF" : String(r.finish_position ?? i + 1).padStart(3, " ");
        const q = fmtLap(r.quali_time_seconds);
        const gap =
          r.quali_time_seconds != null && poleTime != null && Number(r.quali_time_seconds) !== Number(poleTime)
            ? `+${(Number(r.quali_time_seconds) - Number(poleTime)).toFixed(3)}`
            : "";
        const lap = fmtLap(r.best_lap_seconds);
        const fl = lap ? `${lap}${r.fastest_lap || Number(r.best_lap_seconds) === bestLap ? "*" : ""}` : "";
        return `${pos} ${pad(dName[r.driver_id] ?? "Unknown", w)} ${pad(tName[r.team_id] ?? "", tw)} ${q.padEnd(8)} ${gap.padEnd(7)} ${raceTimeLabel(r, winnerTime).padEnd(9)} ${fl.padEnd(8)} ${String(Number(r.points_earned ?? 0)).padStart(3)}`;
      });
      let driverBody = "```\n" + [header, ...lines].join("\n") + "\n```";
      const LIMIT = 3300;
      while (driverBody.length > LIMIT && lines.length > 1) {
        lines.pop();
        driverBody = "```\n" + [header, ...lines].join("\n") + "\n```";
      }

      // Constructor totals: this round + season to date.
      const roundPts = new Map<string, number>();
      for (const r of rows as any[]) {
        if (!r.team_id) continue;
        roundPts.set(r.team_id, (roundPts.get(r.team_id) ?? 0) + Number(r.points_earned ?? 0));
      }
      const { data: live } = await pb
        .from("constructor_standings_live")
        .select("franchise_id, points")
        .eq("league_id", leagueId)
        .eq("season", seasonKey);
      const seasonPts = new Map<string, number>((live ?? []).map((l: any) => [l.franchise_id, Number(l.points)]));
      const teamRows = [...roundPts.entries()]
        .map(([id, pts]) => ({ name: tName[id] ?? "Unknown team", pts, total: seasonPts.get(id) ?? pts }))
        .sort((a, b) => b.pts - a.pts || b.total - a.total);
      const nw = Math.min(22, Math.max(8, ...teamRows.map((t) => t.name.length)));
      const tLines = teamRows.map(
        (t, i) => `${String(i + 1).padStart(2)}  ${pad(t.name, nw)}  ${String(t.pts).padStart(4)}  ${String(t.total).padStart(5)}`
      );
      const tHeader = `${"".padStart(2)}  ${pad("Team", nw)}  ${"Rnd".padStart(4)}  ${"Total".padStart(5)}`;
      const teamBody = "```\n" + [tHeader, ...tLines].join("\n") + "\n```";
      return { driverBody, teamBody };
    };

    for (const kind of ["race", "quali", "stats"] as const) {
      const channelId =
        kind === "race" ? cfg.race_channel_id : kind === "quali" ? cfg.quali_channel_id : cfg.stats_channel_id;
      if (!channelId) continue;
      if (kind === "quali" && !rows.some((r: any) => r.qualifying_position != null)) continue;

      const { data: prev } = await pb
        .from("round_results_discord")
        .select("message_id, channel_id")
        .eq("league_id", leagueId)
        .eq("season", seasonKey)
        .eq("round", roundNum)
        .eq("kind", kind)
        .maybeSingle();

      const cardUrl = kind === "stats" ? null : buildCardUrl({ kind, league_id: leagueId, season: seasonKey, round: roundNum });
      const statsBodies = kind === "stats" ? await buildStats() : null;
      const messageId = await send(
        token,
        channelId,
        prev && prev.channel_id === channelId ? prev.message_id : null,
        statsBodies
          ? {
              embeds: [
                {
                  author: authorOf(league),
                  title: "Full Stats",
                  description: `**${heading}**\n${statsBodies.driverBody}`,
                  color: 0xe8284a,
                  timestamp: new Date().toISOString(),
                },
                {
                  title: "Constructors",
                  description: statsBodies.teamBody,
                  color: 0xe8284a,
                  footer: { text: "* = fastest lap" },
                },
              ],
              allowed_mentions: { parse: [] },
            }
          : {
          embeds: [
            {
              author: authorOf(league),
              title: kind === "quali" ? "Qualifying Results" : "Race Results",
              ...(cardUrl
                ? { description: `**${heading}**`, image: { url: cardUrl } }
                : { description: `**${heading}**\n${build(kind === "quali" ? "quali" : "race")}` }),
              color: 0xe8284a,
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [] },
        }
      );

      await pb.from("round_results_discord").upsert({
        league_id: leagueId,
        season: seasonKey,
        round: roundNum,
        kind,
        channel_id: channelId,
        message_id: messageId,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("[standings-post] round results post failed", err);
  }
}
