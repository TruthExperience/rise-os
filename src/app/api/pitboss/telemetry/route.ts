import { NextRequest, NextResponse } from "next/server";
import { getTelemetrySession } from "@/lib/telemetry";

export async function GET(req: NextRequest) {
  const sessionUid = req.nextUrl.searchParams.get("session_uid");
  if (!sessionUid) {
    return NextResponse.json({ error: "session_uid is required" }, { status: 400 });
  }

  try {
    const session = await getTelemetrySession(sessionUid);
    if (!session) {
      return NextResponse.json({ error: "no telemetry found for session_uid" }, { status: 404 });
    }
    return NextResponse.json(session);
  } catch (err) {
    console.error("[pitboss/telemetry] fetch failed", err);
    return NextResponse.json({ error: "failed to load telemetry" }, { status: 500 });
  }
}
