// src/app/api/cron/cfb-irl-records/route.ts
//
// Weekly: adds completed FBS games for the current season to each
// franchise's all-time IRL record (rise_os.franchises.irl_lifetime_*).
//
// The stored totals run through the 2025 season, so this only adds games
// from the season being processed. Each game is stored once in
// rise_os.irl_game_results (unique on espn_event_id + franchise_id) and the
// totals are updated in the same transaction by rise_os.apply_irl_games()
// (see 14_migration_apply_irl_games.sql), so re-running never double counts.
//
// Only franchises that have an espn_team_id and a baseline record
// (irl_lifetime_wins not null) are touched.
//
// Auth: Authorization: Bearer CRON_SECRET (what Vercel Cron sends), or
// ?secret=CRON_SECRET for running it by hand from a browser.
// Options: ?dry=1 (report only, writes nothing), ?season=2026.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PITBOSS_WORKER_URL =
  process.env.PITBOSS_WORKER_URL || 'https://pitboss-proxy.truthexper.workers.dev';

const CONCURRENCY = 6;
const TIME_BUDGET_MS = 270_000;
const ESPN_FETCH_RETRIES = 2;
const ESPN_RETRY_DELAY_MS = 1000;

type GameRow = {
  espn_event_id: string;
  season: number;
  week: number | null;
  opponent_name: string | null;
  team_score: number;
  opponent_score: number;
  result: 'W' | 'L' | 'T';
  game_date: string | null;
};

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET must not match anything.
  if (!secret) return false;
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;
  return new URL(request.url).searchParams.get('secret') === secret;
}

// FBS season year: Jan-Jun belongs to the season that started the year before.
function currentCfbSeason(now = new Date()): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ESPN is routed through pitboss-proxy, same as the hbcu-rosters cron
// (ESPN blocks Vercel's egress IPs).
async function espnFetch(url: string): Promise<Response> {
  const key = process.env.PITBOSS_INTERNAL_KEY;
  if (!key) throw new Error('PITBOSS_INTERNAL_KEY is not set');
  const relayUrl = `${PITBOSS_WORKER_URL}/espn-relay?url=${encodeURIComponent(url)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= ESPN_FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(relayUrl, { headers: { 'X-PitBoss-Key': key } });
      if (res.ok) return res;
      if (res.status !== 403 && res.status !== 429 && res.status !== 502) return res;
      lastErr = new Error(`ESPN relay fetch failed: ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < ESPN_FETCH_RETRIES) {
      await new Promise((r) => setTimeout(r, ESPN_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('ESPN relay fetch failed after retries');
}

function toNum(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'object') v = v.value ?? v.displayValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseGames(json: any, espnTeamId: string, season: number): GameRow[] {
  const games: GameRow[] = [];
  for (const ev of json?.events ?? []) {
    const comp = ev?.competitions?.[0];
    if (!comp || !comp.status?.type?.completed) continue;

    const competitors: any[] = comp.competitors ?? [];
    const me = competitors.find((c) => String(c?.team?.id ?? c?.id) === espnTeamId);
    const opp = competitors.find((c) => c !== me);
    if (!me || !opp || !ev.id) continue;

    const ms = toNum(me.score);
    const os = toNum(opp.score);
    if (ms == null || os == null) continue;

    games.push({
      espn_event_id: String(ev.id),
      season,
      week: ev.week?.number ?? null,
      opponent_name: opp.team?.displayName ?? opp.team?.location ?? null,
      team_score: ms,
      opponent_score: os,
      result: ms > os ? 'W' : ms < os ? 'L' : 'T',
      game_date: typeof ev.date === 'string' ? ev.date.slice(0, 10) : null,
    });
  }
  return games;
}

async function fetchTeamGames(espnTeamId: string, season: number): Promise<GameRow[]> {
  const base = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${espnTeamId}/schedule?season=${season}`;
  const month = new Date().getUTCMonth(); // Dec, Jan, Feb: postseason games exist
  const seasonTypes = month === 11 || month <= 1 ? [2, 3] : [2];

  const byId = new Map<string, GameRow>();
  for (const st of seasonTypes) {
    const res = await espnFetch(`${base}&seasontype=${st}`);
    if (!res.ok) throw new Error(`ESPN schedule ${espnTeamId} (type ${st}) returned ${res.status}`);
    for (const g of parseGames(await res.json(), espnTeamId, season)) byId.set(g.espn_event_id, g);
  }
  return [...byId.values()];
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1';
  const season = Number(url.searchParams.get('season')) || currentCfbSeason();
  const deadline = Date.now() + TIME_BUDGET_MS;

  const db = createAdminClient().schema('rise_os');

  const { data: franchises, error } = await db
    .from('franchises')
    .select('id, name, espn_team_id')
    .not('espn_team_id', 'is', null)
    .not('irl_lifetime_wins', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!franchises?.length) {
    return NextResponse.json({
      ok: true,
      season,
      note:
        'No franchises have both an espn_team_id and a baseline record, so nothing was updated. ' +
        'Match ESPN teams first (GET/POST /api/admin/espn-team-matches).',
    });
  }

  // Several franchises (one per league) can share an ESPN team: fetch each team once.
  const byTeam = new Map<string, { id: string; name: string }[]>();
  for (const f of franchises) {
    const key = String(f.espn_team_id);
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key)!.push({ id: f.id, name: f.name });
  }

  const teamIds = [...byTeam.keys()];
  const summary = {
    teams: teamIds.length,
    teamsFetched: 0,
    franchisesTouched: 0,
    gamesAdded: 0,
    skippedNoBaseline: 0,
    errors: [] as string[],
    partial: false,
  };
  const addError = (msg: string) => {
    if (summary.errors.length < 25) summary.errors.push(msg);
  };

  let next = 0;
  async function worker() {
    while (true) {
      if (Date.now() > deadline) {
        summary.partial = true;
        return;
      }
      const i = next++;
      if (i >= teamIds.length) return;
      const espnTeamId = teamIds[i];

      let games: GameRow[];
      try {
        games = await fetchTeamGames(espnTeamId, season);
        summary.teamsFetched++;
      } catch (err) {
        addError(`team ${espnTeamId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (games.length === 0) continue;

      for (const f of byTeam.get(espnTeamId)!) {
        try {
          if (dry) {
            const { data: existing } = await db
              .from('irl_game_results')
              .select('espn_event_id')
              .eq('franchise_id', f.id)
              .in('espn_event_id', games.map((g) => g.espn_event_id));
            const have = new Set((existing ?? []).map((r: any) => r.espn_event_id));
            const fresh = games.filter((g) => !have.has(g.espn_event_id)).length;
            if (fresh > 0) summary.franchisesTouched++;
            summary.gamesAdded += fresh;
            continue;
          }

          const { data, error: rpcErr } = await db.rpc('apply_irl_games', {
            p_franchise_id: f.id,
            p_games: games,
          });
          if (rpcErr) {
            addError(`${f.name}: ${rpcErr.message}`);
            continue;
          }
          if (data?.skipped) {
            summary.skippedNoBaseline++;
            continue;
          }
          const added = (data?.wins ?? 0) + (data?.losses ?? 0) + (data?.ties ?? 0);
          if (added > 0) summary.franchisesTouched++;
          summary.gamesAdded += added;
        } catch (err) {
          addError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return NextResponse.json({ ok: summary.errors.length === 0, dry, season, ...summary });
}
