// File: src/app/api/pitboss/fm/setups/mark-optimal/route.ts
//
// Lets a driver confirm that a setup actually worked in-game, promoting it
// to the circuit+conditions memory bank as a verified result. This is a
// distinct signal from the search's own convergence: `nearestSetup` only
// knows a setup is *consistent* with recorded feedback, never that it was
// actually driven and felt right. A driver's confirmation overrides that —
// it writes unconditionally, bypassing upsertFmSetupMemory's normal
// "only if at least as good" guard in fm-setup-engine-data.ts.
//
// Schema dependency (fm_setup_memory.verified / verified_session_id,
// fm_setup_sessions.marked_optimal_at) — already applied to the Tops
// Supabase project.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveDriverIdFromSession } from "@/lib/pitboss/resolveDriver";
import { FM_SETUP_PARAM_ORDER, FmSetupParamKey } from "@/lib/pitboss/fm-setup-engine";

interface MarkOptimalRequestBody {
  session_id: string;
  discord_id?: string | null;
  driver_id?: string | null;
  // Which setup to confirm. Defaults to the session's current_values, but
  // callers marking a specific ranked candidate from history (rather than
  // whatever's currently on the sliders) should pass it explicitly.
  setup_values?: Record<FmSetupParamKey, number>;
}

export async function POST(req: NextRequest) {
  let body: MarkOptimalRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, discord_id = null, driver_id: driverIdOverride = null, setup_values } = body;

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
    .select("id, driver_id, circuit_id, conditions, current_values")
    .eq("id", session_id)
    .maybeSingle();

  if (sessionErr) {
    return NextResponse.json({ error: sessionErr.message }, { status: 500 });
  }
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Only the driver who owns this session can confirm its setup — a
  // teammate or steward looking at the same circuit shouldn't be able to
  // overwrite the memory bank from a session that isn't theirs.
  if (session.driver_id !== driver_id) {
    return NextResponse.json({ error: "Session does not belong to this driver" }, { status: 403 });
  }

  const confirmedValues = setup_values ?? session.current_values;
  if (!confirmedValues || Object.keys(confirmedValues).length !== FM_SETUP_PARAM_ORDER.length) {
    return NextResponse.json(
      { error: "No complete setup on this session to confirm — provide setup_values" },
      { status: 422 },
    );
  }

  const { data: existing, error: fetchErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_memory")
    .select("sample_count")
    .eq("circuit_id", session.circuit_id)
    .eq("conditions", session.conditions)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  // Unconditional upsert — a driver's in-game confirmation outranks the
  // usual "only if lowest_rule_break is at least as good" guard.
  // lowest_rule_break: 0 marks it fully consistent by definition.
  const { error: upsertErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_memory")
    .upsert(
      {
        circuit_id: session.circuit_id,
        conditions: session.conditions,
        setup_values: confirmedValues,
        lowest_rule_break: 0,
        possible_setups: 1,
        sample_count: (existing?.sample_count ?? 0) + 1,
        verified: true,
        verified_session_id: session.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "circuit_id,conditions" },
    );

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  const { error: sessionUpdateErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_sessions")
    .update({ marked_optimal_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", session.id);

  if (sessionUpdateErr) {
    return NextResponse.json({ error: sessionUpdateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    circuit_id: session.circuit_id,
    conditions: session.conditions,
  });
}
