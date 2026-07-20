// File: src/app/api/pitboss/fm/setups/history/route.ts
//
// Returns the feedback-log audit trail for one session, in iteration order,
// for the frontend history panel. Read-only — no writes here.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveDriverIdFromSession } from "@/lib/pitboss/resolveDriver";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const session_id = searchParams.get("session_id");
  const discord_id = searchParams.get("discord_id");
  const driverIdOverride = searchParams.get("driver_id");

  if (!session_id) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }

  let driver_id: string | null = null;
  if (discord_id) {
    driver_id = await resolveDriverIdFromSession(discord_id);
  }
  if (!driver_id && driverIdOverride) {
    driver_id = driverIdOverride;
  }
  if (!driver_id) {
    return NextResponse.json({ error: "Could not resolve driver identity" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: session, error: sessionErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_sessions")
    .select("id, driver_id, circuit_id, conditions, marked_optimal_at")
    .eq("id", session_id)
    .maybeSingle();

  if (sessionErr) return NextResponse.json({ error: sessionErr.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.driver_id !== driver_id) {
    return NextResponse.json({ error: "Session does not belong to this driver" }, { status: 403 });
  }

  const { data: log, error: logErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_feedback_log")
    .select("iteration_number, feedback, applied_deltas, created_at")
    .eq("session_id", session_id)
    .order("iteration_number", { ascending: true });

  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });

  return NextResponse.json({
    session_id,
    marked_optimal_at: session.marked_optimal_at ?? null,
    iterations: log ?? [],
  });
}
