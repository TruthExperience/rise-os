import { NextRequest, NextResponse } from "next/server";
import { getAuthedDriver, createAdminClient } from "@/lib/supabase/server";

/**
 * Thumbs up/down (+ optional corrected text) on a coaching report.
 *
 * POST /api/pitboss/telemetry/coach/feedback
 *   body: { report_id, target_kind, target_index?, rating, edited_text?, reason? }
 *   - target_kind: "summary" | "corner" | "straight" | "suggestion"
 *   - target_index: array index into the report (omit / -1 for "summary")
 *   - rating: 1 | -1
 *   Only the report's own driver may rate it. The coach's original wording is
 *   read from the saved report server-side, never from the client.
 *
 * GET /api/pitboss/telemetry/coach/feedback?report_id=...
 *   Lists feedback for a report. Owner, or a steward in a league the report's
 *   driver belongs to (same check shape as the trends route).
 */

const KINDS = ["summary", "corner", "straight", "suggestion"] as const;
type Kind = (typeof KINDS)[number];

type FullReport = {
  summaryText?: string;
  corners?: { coachingNote?: string }[];
  straights?: { coachingNote?: string }[];
  suggestions?: string[];
  narrativeSource?: string;
};

function originalText(report: FullReport, kind: Kind, index: number): string | null {
  switch (kind) {
    case "summary":
      return report.summaryText ?? null;
    case "corner":
      return report.corners?.[index]?.coachingNote ?? null;
    case "straight":
      return report.straights?.[index]?.coachingNote ?? null;
    case "suggestion":
      return report.suggestions?.[index] ?? null;
  }
}

async function isStewardOverDriver(requesterId: string, targetDriverId: string) {
  const admin = createAdminClient();
  const { data: targetLeagues } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("league_id")
    .eq("driver_id", targetDriverId);

  const leagueIds = (targetLeagues ?? []).map((r) => r.league_id);
  if (leagueIds.length === 0) return false;

  const { data: membership } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_steward, is_head_steward")
    .eq("driver_id", requesterId)
    .in("league_id", leagueIds)
    .or("is_steward.eq.true,is_head_steward.eq.true");
  return !!membership && membership.length > 0;
}

export async function POST(req: NextRequest) {
  const requester = await getAuthedDriver();
  if (!requester) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const reportId = typeof body.report_id === "string" ? body.report_id : null;
  const kind = body.target_kind as Kind;
  const rating = body.rating;
  const editedText =
    typeof body.edited_text === "string" && body.edited_text.trim()
      ? body.edited_text.trim().slice(0, 2000)
      : null;
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;

  if (!reportId) {
    return NextResponse.json({ error: "report_id required" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "invalid target_kind" }, { status: 400 });
  }
  if (rating !== 1 && rating !== -1) {
    return NextResponse.json({ error: "rating must be 1 or -1" }, { status: 400 });
  }

  const index = kind === "summary" ? -1 : Number(body.target_index);
  if (kind !== "summary" && (!Number.isInteger(index) || index < 0)) {
    return NextResponse.json({ error: "target_index must be a non-negative integer" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: report, error: reportErr } = await admin
    .schema("pitboss")
    .from("coaching_reports")
    .select("id, driver_id, track_id, car_class_id, full_report")
    .eq("id", reportId)
    .maybeSingle();

  if (reportErr) {
    console.error("[pitboss/telemetry/coach/feedback] report lookup failed", reportErr);
    return NextResponse.json({ error: "failed to load report" }, { status: 500 });
  }
  if (!report) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }
  // Only the driver the report was generated for can rate it.
  if (report.driver_id !== requester.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const full = (report.full_report ?? {}) as FullReport;
  const original = originalText(full, kind, index);
  if (!original) {
    return NextResponse.json({ error: "target not found in report" }, { status: 400 });
  }

  const { data, error } = await admin
    .schema("pitboss")
    .from("coach_feedback")
    .upsert(
      {
        report_id: report.id,
        driver_id: requester.id,
        track_id: report.track_id,
        car_class_id: report.car_class_id,
        target_kind: kind,
        target_index: index,
        original_text: original,
        rating,
        edited_text: editedText,
        reason,
        narrative_source: full.narrativeSource ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "report_id,driver_id,target_kind,target_index" },
    )
    .select()
    .single();

  if (error) {
    console.error("[pitboss/telemetry/coach/feedback] save failed", error);
    return NextResponse.json({ error: "failed to save feedback" }, { status: 500 });
  }
  return NextResponse.json({ feedback: data });
}

export async function GET(req: NextRequest) {
  const requester = await getAuthedDriver();
  if (!requester) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportId = req.nextUrl.searchParams.get("report_id");
  if (!reportId) {
    return NextResponse.json({ error: "report_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: report } = await admin
    .schema("pitboss")
    .from("coaching_reports")
    .select("id, driver_id")
    .eq("id", reportId)
    .maybeSingle();

  if (!report) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }
  if (
    report.driver_id !== requester.id &&
    !(await isStewardOverDriver(requester.id, report.driver_id))
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data, error } = await admin
    .schema("pitboss")
    .from("coach_feedback")
    .select("*")
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[pitboss/telemetry/coach/feedback] list failed", error);
    return NextResponse.json({ error: "failed to load feedback" }, { status: 500 });
  }
  return NextResponse.json({ feedback: data ?? [] });
}
