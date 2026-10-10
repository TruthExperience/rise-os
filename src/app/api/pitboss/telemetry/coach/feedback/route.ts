// =====================================================
// FILE: src/app/api/pitboss/telemetry/coach/feedback/route.ts
// =====================================================
//
// Thumbs up/down (+ optional corrected text) on a single coaching note.
//   POST  { reportId, targetKind, targetIndex?, rating, editedText?, reason? }
//   GET   ?reportId=...   -> existing feedback rows for that report
//
// ASSUMPTIONS to adjust to your repo:
//   - next-auth session helper: getServerSession(authOptions) from '@/lib/auth'
//   - ownership: the feedback is attributed to the report's own driver_id.
//     Add a check that session.user maps to that driver if you want to stop
//     other logged-in users rating someone else's report.

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const TARGET_KINDS = ['summary', 'corner', 'straight', 'suggestion'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

const MAX_TEXT = 2000;

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

// Pulls the exact text the coach produced for this target out of the saved
// report, so the client can't submit a made-up "original".
function originalTextFor(report: any, kind: TargetKind, index: number): string | null {
  const full = report?.full_report;
  if (!full) return null;
  if (kind === 'summary') return typeof full.summaryText === 'string' ? full.summaryText : null;
  if (kind === 'suggestion') {
    const s = Array.isArray(full.suggestions) ? full.suggestions[index] : null;
    return typeof s === 'string' ? s : null;
  }
  if (kind === 'corner') {
    const c = Array.isArray(full.corners) ? full.corners.find((x: any) => x?.corner?.id === index) : null;
    if (!c) return null;
    return [c.coachingNote, c.suggestion].filter(Boolean).join(' | ') || null;
  }
  const s = Array.isArray(full.straights) ? full.straights.find((x: any) => x?.straight?.id === index) : null;
  if (!s) return null;
  return [s.coachingNote, s.suggestion].filter(Boolean).join(' | ') || null;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const reportId = typeof body?.reportId === 'string' ? body.reportId : null;
  const targetKind = body?.targetKind as TargetKind;
  const targetIndex = Number.isInteger(body?.targetIndex) ? (body.targetIndex as number) : -1;
  const rating = body?.rating;

  if (!reportId) return NextResponse.json({ error: 'reportId required' }, { status: 400 });
  if (!TARGET_KINDS.includes(targetKind)) return NextResponse.json({ error: 'Invalid targetKind' }, { status: 400 });
  if (rating !== 1 && rating !== -1) return NextResponse.json({ error: 'rating must be 1 or -1' }, { status: 400 });
  if (targetKind !== 'summary' && targetIndex < 0) {
    return NextResponse.json({ error: 'targetIndex required for this targetKind' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: report, error: reportErr } = await supabase
    .schema('pitboss')
    .from('coaching_reports')
    .select('id, driver_id, track_id, car_class_id, narrative_source, full_report')
    .eq('id', reportId)
    .maybeSingle();

  if (reportErr) {
    console.error('[coach-feedback] report lookup failed:', reportErr.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });

  const original = originalTextFor(report, targetKind, targetIndex);
  if (!original) return NextResponse.json({ error: 'Target not found in report' }, { status: 404 });

  const row = {
    report_id: report.id,
    driver_id: report.driver_id,
    track_id: report.track_id,
    car_class_id: report.car_class_id,
    target_kind: targetKind,
    target_index: targetKind === 'summary' ? -1 : targetIndex,
    original_text: original,
    rating,
    edited_text: cleanText(body?.editedText),
    reason: cleanText(body?.reason),
    narrative_source: report.narrative_source,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .schema('pitboss')
    .from('coach_feedback')
    .upsert(row, { onConflict: 'report_id,driver_id,target_kind,target_index' });

  if (error) {
    console.error('[coach-feedback] upsert failed:', error.message);
    return NextResponse.json({ error: 'Save failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const reportId = new URL(req.url).searchParams.get('reportId');
  if (!reportId) return NextResponse.json({ error: 'reportId required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema('pitboss')
    .from('coach_feedback')
    .select('target_kind, target_index, rating, edited_text, reason, updated_at')
    .eq('report_id', reportId);

  if (error) {
    console.error('[coach-feedback] fetch failed:', error.message);
    return NextResponse.json({ error: 'Fetch failed' }, { status: 500 });
  }
  return NextResponse.json({ feedback: data ?? [] });
}
