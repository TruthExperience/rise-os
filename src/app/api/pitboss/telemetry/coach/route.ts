import { NextRequest, NextResponse } from "next/server";
import { getTelemetrySession } from "@/lib/telemetry";
import { buildCoachingReport } from "@/lib/pitboss/telemetry-coach";
import { getCachedCoachingReport, persistCoachingReport } from "@/lib/pitboss/coaching-history";
import { getAuthedDriver } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const sessionUid = req.nextUrl.searchParams.get("session_uid");
  if (!sessionUid) {
    return NextResponse.json({ error: "session_uid is required" }, { status: 400 });
  }

  const lapParam = req.nextUrl.searchParams.get("lap");
  if (!lapParam) {
    return NextResponse.json({ error: "lap is required" }, { status: 400 });
  }
  const lapNum = Number(lapParam);
  if (!Number.isInteger(lapNum)) {
    return NextResponse.json({ error: "lap must be an integer" }, { status: 400 });
  }

  const referenceLapParam = req.nextUrl.searchParams.get("reference_lap");
  let referenceLapNum: number | undefined;
  if (referenceLapParam != null) {
    referenceLapNum = Number(referenceLapParam);
    if (!Number.isInteger(referenceLapNum)) {
      return NextResponse.json({ error: "reference_lap must be an integer" }, { status: 400 });
    }
  }

  const requester = await getAuthedDriver();
  if (!requester) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const session = await getTelemetrySession(sessionUid);
    if (!session) {
      return NextResponse.json({ error: "no telemetry found for session_uid" }, { status: 404 });
    }

    // Same own-session-or-steward check as GET /api/pitboss/telemetry —
    // keep these two routes' access rules in sync if either changes.
    if (session.driverId !== requester.id) {
      const admin = createAdminClient();
      const { data: upload } = await admin
        .schema("pitboss")
        .from("setup_telemetry_uploads")
        .select("submission_id, setup_submissions(league_id)")
        .eq("session_uid", sessionUid)
        .limit(1)
        .maybeSingle();

      const leagueId = (upload as any)?.setup_submissions?.league_id ?? null;

      let isSteward = false;
      if (leagueId) {
        const { data: membership } = await admin
          .schema("pitboss")
          .from("driver_leagues")
          .select("is_steward, is_head_steward")
          .eq("driver_id", requester.id)
          .eq("league_id", leagueId)
          .maybeSingle();
        isSteward = !!(membership?.is_steward || membership?.is_head_steward);
      }

      if (!isSteward) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const cached = await getCachedCoachingReport(sessionUid, lapNum, referenceLapNum ?? null);
    if (cached) {
      return NextResponse.json(cached);
    }

    const report = await buildCoachingReport(session, lapNum, referenceLapNum);

    // Best-effort cache write so the next request for this exact
    // (session_uid, lap_num, reference_lap) pair — and the season-long
    // trends endpoint — can pick it up. A failure here must not affect
    // the response; the driver still gets their report either way, just
    // without it feeding the trend history this one time.
    try {
      const admin = createAdminClient();
      const { data: uploadRow } = await admin
        .schema("pitboss")
        .from("setup_telemetry_uploads")
        .select("track_id, car_class_id, lap_time_seconds")
        .eq("session_uid", sessionUid)
        .eq("lap_num", lapNum)
        .maybeSingle();

      if (session.driverId) {
        const lapValid = session.laps.find((l) => l.lapNum === lapNum)?.lapValid ?? true;
        await persistCoachingReport({
          driverId: session.driverId,
          trackId: uploadRow?.track_id ?? null,
          carClassId: uploadRow?.car_class_id ?? null,
          sessionUid,
          lapNum,
          referenceLapNum: referenceLapNum ?? null,
          lapTimeSeconds: uploadRow?.lap_time_seconds != null ? Number(uploadRow.lap_time_seconds) : null,
          lapValid,
          report,
        });
      }
    } catch (cacheErr) {
      console.error(
        "[pitboss/telemetry/coach] cache write failed (report still returned):",
        cacheErr instanceof Error ? cacheErr.message : cacheErr
      );
    }

    return NextResponse.json(report);
  } catch (err) {
    // buildCoachingReport throws a plain Error (not a DB/auth failure) when
    // the requested lap number doesn't exist in this session — surface that
    // as 404 rather than a generic 500.
    if (err instanceof Error && err.message.startsWith("Lap ") && err.message.includes("not found in session")) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[pitboss/telemetry/coach] failed", err);
    return NextResponse.json({ error: "failed to generate coaching report" }, { status: 500 });
  }
}
