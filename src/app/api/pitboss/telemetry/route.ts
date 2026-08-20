import { NextRequest, NextResponse } from "next/server";
import { getTelemetrySession } from "@/lib/telemetry";
import { getAuthedDriver } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const sessionUid = req.nextUrl.searchParams.get("session_uid");
  if (!sessionUid) {
    return NextResponse.json({ error: "session_uid is required" }, { status: 400 });
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

    return NextResponse.json(session);
  } catch (err) {
    console.error("[pitboss/telemetry] fetch failed", err);
    return NextResponse.json({ error: "failed to load telemetry" }, { status: 500 });
  }
}
