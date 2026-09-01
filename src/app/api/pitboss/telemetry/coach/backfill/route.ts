// app/api/pitboss/telemetry/coach/backfill/route.ts
//
// One-off (repeatable) backfill for pitboss.coaching_reports. The dynamic
// coaching pass added to telemetry-ingest/route.ts only runs on laps
// ingested AFTER that change shipped — this route runs the same
// buildCoachingReport + persistCoachingReport pipeline against every
// existing valid lap in setup_telemetry_uploads that doesn't have a
// coaching_reports row yet, so season-long trends aren't blind to
// everything uploaded before this feature existed.
//
// BATCHED, NOT ONE-SHOT: each call processes up to `limit` laps (default
// 10) and returns how many are still missing. Call it repeatedly (a
// browser refresh, curl loop, or a temporary Vercel Cron entry) until
// `done: true`. This is deliberate, not a shortcut — each lap's coaching
// narrative is an LLM call through pitboss-proxy's waterfall, which can
// legitimately take up to ~25s in the worst case (see DEFAULT_TIMEOUT_MS
// in lib/pitboss-llm.ts); a handful of unlucky laps in one batch could
// otherwise approach the function's maxDuration.
//
// AUTH: same CRON_SECRET Bearer-token gate as the other admin/cron routes
// in this repo (see api/cron/ea-ratings-all for the original pattern) —
// reuses the existing env var rather than introducing a new secret.
//
// vercel.json:
//   "src/app/api/pitboss/telemetry/coach/backfill/route.ts": { "maxDuration": 300 }

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getTelemetrySession } from '@/lib/telemetry';
import { buildCoachingReport } from '@/lib/pitboss/telemetry-coach';
import { persistCoachingReport } from '@/lib/pitboss/coaching-history';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

interface PendingLap {
  session_uid: string;
  lap_num: number;
  driver_id: string;
  track_id: string | null;
  car_class_id: string | null;
  lap_time_seconds: number | null;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const limitParam = request.nextUrl.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam != null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const admin = createAdminClient();

  // Every valid uploaded lap, oldest first — so a backfill that spans
  // multiple calls fills in chronological order, matching what the
  // trends endpoint's "recent half vs earlier half" comparison assumes.
  const { data: uploads, error: uploadsError } = await admin
    .schema('pitboss')
    .from('setup_telemetry_uploads')
    .select('session_uid, lap_num, driver_id, track_id, car_class_id, lap_time_seconds')
    .eq('lap_valid', true)
    .not('driver_id', 'is', null)
    .order('created_at', { ascending: true });

  if (uploadsError) {
    return NextResponse.json({ error: `Failed to list telemetry uploads: ${uploadsError.message}` }, { status: 500 });
  }

  const { data: existingReports, error: reportsError } = await admin
    .schema('pitboss')
    .from('coaching_reports')
    .select('session_uid, lap_num');

  if (reportsError) {
    return NextResponse.json({ error: `Failed to list existing coaching reports: ${reportsError.message}` }, { status: 500 });
  }

  const alreadyDone = new Set((existingReports ?? []).map((r) => `${r.session_uid}:${r.lap_num}`));
  const pending: PendingLap[] = (uploads ?? [])
    .filter((u) => !alreadyDone.has(`${u.session_uid}:${u.lap_num}`))
    .map((u) => ({
      session_uid: u.session_uid,
      lap_num: u.lap_num,
      driver_id: u.driver_id as string,
      track_id: u.track_id,
      car_class_id: u.car_class_id,
      lap_time_seconds: u.lap_time_seconds != null ? Number(u.lap_time_seconds) : null,
    }));

  const batch = pending.slice(0, limit);
  const results: { session_uid: string; lap_num: number; status: 'ok' | 'error'; error?: string }[] = [];

  // Cache getTelemetrySession per session_uid within this batch — a
  // session with multiple pending laps shouldn't re-fetch/re-parse the
  // same archived telemetry frames once per lap.
  const sessionCache = new Map<string, Awaited<ReturnType<typeof getTelemetrySession>>>();

  for (const item of batch) {
    try {
      let session = sessionCache.get(item.session_uid);
      if (session === undefined) {
        session = await getTelemetrySession(item.session_uid);
        sessionCache.set(item.session_uid, session);
      }
      if (!session) {
        results.push({ session_uid: item.session_uid, lap_num: item.lap_num, status: 'error', error: 'session not found' });
        continue;
      }

      const otherValidLaps = session.laps.filter((l) => l.lapNum !== item.lap_num && l.lapValid);
      const bestOther = otherValidLaps.reduce<typeof otherValidLaps[number] | null>(
        (best, candidate) => (!best || candidate.lapTime < best.lapTime ? candidate : best),
        null
      );
      const referenceLapNum = bestOther?.lapNum ?? undefined;

      const report = await buildCoachingReport(session, item.lap_num, referenceLapNum);
      await persistCoachingReport({
        driverId: item.driver_id,
        trackId: item.track_id,
        carClassId: item.car_class_id,
        sessionUid: item.session_uid,
        lapNum: item.lap_num,
        referenceLapNum: referenceLapNum ?? null,
        lapTimeSeconds: item.lap_time_seconds,
        lapValid: true,
        report,
      });

      results.push({ session_uid: item.session_uid, lap_num: item.lap_num, status: 'ok' });
    } catch (err) {
      // One bad lap (missing frames, LLM timeout, whatever) must not stop
      // the rest of the batch — log and move on, it'll just stay pending
      // for the next call to retry.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[coach/backfill] failed for ${item.session_uid} lap ${item.lap_num}:`, message);
      results.push({ session_uid: item.session_uid, lap_num: item.lap_num, status: 'error', error: message });
    }
  }

  const succeeded = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const remaining = pending.length - batch.length;

  return NextResponse.json({
    processed: results.length,
    succeeded,
    failed,
    remaining,
    done: remaining === 0,
    results,
  });
}
