// src/app/api/cron/racing-team-records/route.ts
//
// Weekly: refreshes the real-life F1 season totals on rise_os.franchises
// (f1_irl_starts, wins, top3, top5, top10, poles, points, dnfs) for
// franchises linked to a current constructor through f1_team_id.
//
// The stored numbers are per-car season totals (2026 Round 9 = 18 starts per
// team), so this recomputes the whole season from the Jolpica F1 API every
// run instead of adding to what is stored. Re-running is safe.
//
// Counting rules (grand prix only, sprints are not included):
//   starts  every classified or retired entry (not did-not-start / withdrew)
//   wins / top3 / top5 / top10  classified finishing position of each car
//   poles   qualifying position 1
//   points  sum of grand prix points
//   dnfs    entries that did not finish and were not merely lapped
//
// Only franchises whose irl_record_source is empty or already starts with
// "jolpica" are updated.
//
// Auth: Authorization: Bearer CRON_SECRET (Vercel Cron), or ?secret=CRON_SECRET.
// Options: ?dry=1 (report only, writes nothing), ?season=2026.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const PAGE_SIZE = 100;
const MAX_PAGES = 12;
const REQUEST_GAP_MS = 400; // stays under Jolpica's burst limit

type Totals = {
  constructorName: string;
  starts: number;
  wins: number;
  top3: number;
  top5: number;
  top10: number;
  poles: number;
  points: number;
  dnfs: number;
};

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;
  return new URL(request.url).searchParams.get('secret') === secret;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jolpicaGet(path: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${JOLPICA}${path}`, { headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
      lastErr = new Error(`Jolpica ${path} returned ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error('Jolpica request failed');
}

// Walks every page of a results-style endpoint and hands each race to the
// callback. A race can be split across pages; callers just count rows.
async function forEachRace(path: string, onRace: (race: any) => void): Promise<void> {
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await jolpicaGet(`${path}?limit=${PAGE_SIZE}&offset=${offset}`);
    const total = Number(json?.MRData?.total ?? 0);
    for (const race of json?.MRData?.RaceTable?.Races ?? []) onRace(race);
    offset += PAGE_SIZE;
    if (offset >= total) return;
    await sleep(REQUEST_GAP_MS);
  }
}

function emptyTotals(name: string): Totals {
  return { constructorName: name, starts: 0, wins: 0, top3: 0, top5: 0, top10: 0, poles: 0, points: 0, dnfs: 0 };
}

const NON_START = /^(did not start|withdrew|did not qualify|did not prequalify)/i;
const FINISHED = /^(finished|\+\d+ laps?)$/i;

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1';
  const season = Number(url.searchParams.get('season')) || new Date().getUTCFullYear();

  const totals = new Map<string, Totals>(); // constructorId -> totals
  let lastRound = 0;

  try {
    await forEachRace(`/${season}/results.json`, (race) => {
      const round = Number(race.round);
      if (round > lastRound) lastRound = round;
      for (const r of race.Results ?? []) {
        const cid = r?.Constructor?.constructorId;
        if (!cid) continue;
        const t = totals.get(cid) ?? emptyTotals(r.Constructor.name ?? cid);
        totals.set(cid, t);

        const status = String(r.status ?? '');
        if (NON_START.test(status)) continue;

        t.starts++;
        t.points += Number(r.points) || 0;
        if (!FINISHED.test(status)) t.dnfs++;

        // positionText is a number only for classified finishers.
        const pos = /^\d+$/.test(String(r.positionText)) ? Number(r.positionText) : null;
        if (pos != null) {
          if (pos === 1) t.wins++;
          if (pos <= 3) t.top3++;
          if (pos <= 5) t.top5++;
          if (pos <= 10) t.top10++;
        }
      }
    });

    await sleep(REQUEST_GAP_MS);

    await forEachRace(`/${season}/qualifying.json`, (race) => {
      for (const q of race.QualifyingResults ?? []) {
        if (String(q.position) !== '1') continue;
        const cid = q?.Constructor?.constructorId;
        if (!cid) continue;
        const t = totals.get(cid) ?? emptyTotals(q.Constructor.name ?? cid);
        totals.set(cid, t);
        t.poles++;
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Jolpica fetch failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  if (totals.size === 0 || lastRound === 0) {
    return NextResponse.json({ ok: true, season, note: 'No race results found for this season yet; nothing updated.' });
  }

  const db = createAdminClient().schema('rise_os');

  // Same keyword idea as the f1_teams auto-link trigger: the longest
  // match_keywords entry found in the constructor name wins.
  const { data: teams, error: teamErr } = await db
    .from('f1_teams')
    .select('id, canonical_name, match_keywords');
  if (teamErr || !teams) {
    return NextResponse.json({ error: teamErr?.message ?? 'Could not load f1_teams' }, { status: 500 });
  }

  const source = `jolpica-f1 / Ergast historical archive (live API), as of ${season} Round ${lastRound}`;
  const nowIso = new Date().toISOString();

  const unresolved: string[] = [];
  const updated: any[] = [];
  const errors: string[] = [];

  for (const [cid, t] of totals) {
    const name = t.constructorName.toLowerCase();
    let best: { id: string; canonical_name: string; len: number } | null = null;
    let tie = false;
    for (const team of teams) {
      for (const kw of (team.match_keywords as string[] | null) ?? []) {
        if (!kw || !name.includes(kw.toLowerCase())) continue;
        if (!best || kw.length > best.len) {
          best = { id: team.id, canonical_name: team.canonical_name, len: kw.length };
          tie = false;
        } else if (kw.length === best.len && best.id !== team.id) {
          tie = true;
        }
      }
    }
    if (!best || tie) {
      unresolved.push(`${t.constructorName} (${cid})`);
      continue;
    }

    const { data: rows, error: selErr } = await db
      .from('franchises')
      .select('id, irl_record_source')
      .eq('f1_team_id', best.id);
    if (selErr) {
      errors.push(`${best.canonical_name}: ${selErr.message}`);
      continue;
    }

    const targets = (rows ?? []).filter(
      (r: any) => r.irl_record_source == null || /^jolpica/i.test(r.irl_record_source)
    );

    updated.push({
      constructor: t.constructorName,
      team: best.canonical_name,
      franchises: targets.length,
      skipped: (rows?.length ?? 0) - targets.length,
      totals: {
        starts: t.starts, wins: t.wins, top3: t.top3, top5: t.top5, top10: t.top10,
        poles: t.poles, points: t.points, dnfs: t.dnfs,
      },
    });

    if (dry || targets.length === 0) continue;

    const { error: updErr } = await db
      .from('franchises')
      .update({
        f1_irl_starts: t.starts,
        f1_irl_wins: t.wins,
        f1_irl_top3: t.top3,
        f1_irl_top5: t.top5,
        f1_irl_top10: t.top10,
        f1_irl_poles: t.poles,
        f1_irl_points: t.points,
        f1_irl_dnfs: t.dnfs,
        f1_irl_updated_at: nowIso,
        irl_record_source: source,
      })
      .in('id', targets.map((r: any) => r.id));
    if (updErr) errors.push(`${best.canonical_name}: ${updErr.message}`);
  }

  return NextResponse.json({
    ok: errors.length === 0,
    dry,
    season,
    lastRound,
    source,
    teamsUpdated: updated.length,
    updated,
    unresolved,
    errors,
  });
}
