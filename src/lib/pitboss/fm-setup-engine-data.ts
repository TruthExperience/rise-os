// File: src/lib/pitboss/fm-setup-engine-data.ts
//
// Shared fetch/persist helpers for the F1 Manager setup engine. Kept
// separate from fm-setup-engine.ts (which is pure logic, no I/O), same
// convention as setup-engine.ts / setup-engine-data.ts on the F1 25 side.

import { createAdminClient } from "@/lib/supabase/server";
import type { FmParamRange, FmSetupParamKey, FmFeedbackByBias, FmBiasKey, FmFeedbackValue } from "./fm-setup-engine";
import { FM_BIAS_ORDER } from "./fm-setup-engine";

function getSupabase() {
  return createAdminClient();
}

export async function fetchFmParamRanges(): Promise<FmParamRange[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("fm_setup_params")
    .select("param_key, min_value, max_value, step")
    .order("display_order");

  if (error) throw new Error(`Failed to load fm setup param ranges: ${error.message}`);

  return (data ?? []).map((r) => ({
    param_key: r.param_key as FmSetupParamKey,
    min_value: Number(r.min_value),
    max_value: Number(r.max_value),
    step: Number(r.step),
  }));
}

export interface FmSetupSessionRow {
  id: string;
  driver_id: string;
  circuit_id: string;
  conditions: "dry" | "wet";
  driver_slot: 1 | 2;
  driver_slot_name: string | null;
  current_values: Record<FmSetupParamKey, number>;
  current_feedback: FmFeedbackByBias;
  iteration_count: number;
}

const SESSION_SELECT =
  "id, driver_id, circuit_id, conditions, driver_slot, driver_slot_name, current_values, current_feedback, iteration_count";

function emptyFeedback(): FmFeedbackByBias {
  const out = {} as FmFeedbackByBias;
  for (const key of FM_BIAS_ORDER) out[key] = [];
  return out;
}

/**
 * Fetches the session for (driver, circuit, conditions, driver_slot), or
 * creates a fresh one if this is the driver's first calculation here.
 * driver_slot is 1|2 (two drivers per team in F1 Manager) — always required.
 */
export async function fetchOrCreateFmSetupSession(params: {
  driverId: string;
  circuitId: string;
  conditions: "dry" | "wet";
  driverSlot: 1 | 2;
  driverSlotName?: string | null;
}): Promise<FmSetupSessionRow> {
  const supabase = getSupabase();
  const { driverId, circuitId, conditions, driverSlot, driverSlotName = null } = params;

  const { data: existing, error: fetchErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_sessions")
    .select(SESSION_SELECT)
    .eq("driver_id", driverId)
    .eq("circuit_id", circuitId)
    .eq("conditions", conditions)
    .eq("driver_slot", driverSlot)
    .maybeSingle();

  if (fetchErr) throw new Error(`Failed to load fm setup session: ${fetchErr.message}`);
  if (existing) return existing as unknown as FmSetupSessionRow;

  const { data: created, error: insertErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_sessions")
    .insert({
      driver_id: driverId,
      circuit_id: circuitId,
      conditions,
      driver_slot: driverSlot,
      driver_slot_name: driverSlotName,
      current_values: {},
      current_feedback: emptyFeedback(),
      iteration_count: 0,
    })
    .select(SESSION_SELECT)
    .single();

  if (insertErr || !created) {
    throw new Error(`Failed to create fm setup session: ${insertErr?.message ?? "unknown error"}`);
  }
  return created as unknown as FmSetupSessionRow;
}

export async function updateFmSetupSession(
  sessionId: string,
  updates: {
    current_values?: Record<FmSetupParamKey, number>;
    current_feedback?: FmFeedbackByBias;
    iteration_count?: number;
  },
): Promise<FmSetupSessionRow> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("fm_setup_sessions")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .select(SESSION_SELECT)
    .single();

  if (error || !data) {
    throw new Error(`Failed to update fm setup session: ${error?.message ?? "unknown error"}`);
  }
  return data as unknown as FmSetupSessionRow;
}

export interface FmFeedbackLogEntry {
  bias: FmBiasKey;
  value: number;
  feedback: FmFeedbackValue;
}

/**
 * Appends an audit row to fm_setup_feedback_log for this calculation.
 * `feedback` is the raw feedback points just recorded this call;
 * `appliedDeltas` is whatever the caller wants to record about the
 * resulting search (e.g. lowestRuleBreak, possibleSetups, chosen candidate)
 * for later debugging/analysis — shape is intentionally loose (jsonb).
 */
export async function logFmFeedback(params: {
  sessionId: string;
  iterationNumber: number;
  feedback: FmFeedbackLogEntry[];
  appliedDeltas: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.schema("pitboss").from("fm_setup_feedback_log").insert({
    session_id: params.sessionId,
    iteration_number: params.iterationNumber,
    feedback: params.feedback,
    applied_deltas: params.appliedDeltas,
  });

  if (error) throw new Error(`Failed to log fm feedback: ${error.message}`);
}

/**
 * Reads the best converged setup on record for a given circuit + conditions,
 * if any driver has ever converged one. Used to seed a brand-new session's
 * anchor bias instead of starting from neutral every time — new drivers get
 * a warm start based on what's already been proven at this circuit.
 */
export async function fetchFmSetupMemory(
  circuitId: string,
  conditions: "dry" | "wet",
): Promise<{
  setup_values: Record<FmSetupParamKey, number>;
  lowest_rule_break: number;
  possible_setups: number;
  sample_count: number;
} | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("fm_setup_memory")
    .select("setup_values, lowest_rule_break, possible_setups, sample_count")
    .eq("circuit_id", circuitId)
    .eq("conditions", conditions)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch fm setup memory: ${error.message}`);
  return data as {
    setup_values: Record<FmSetupParamKey, number>;
    lowest_rule_break: number;
    possible_setups: number;
    sample_count: number;
  } | null;
}

/**
 * Records a converged setup for a circuit + conditions, but only if it's at
 * least as good (lowest_rule_break <= what's stored) as the current best —
 * the memory bank should monotonically improve, never regress toward a
 * worse-converged setup from an earlier or noisier session.
 */
export async function upsertFmSetupMemory(params: {
  circuitId: string;
  conditions: "dry" | "wet";
  setupValues: Record<FmSetupParamKey, number>;
  lowestRuleBreak: number;
  possibleSetups: number;
}): Promise<void> {
  const supabase = getSupabase();

  const { data: existing, error: fetchErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_memory")
    .select("id, lowest_rule_break, sample_count")
    .eq("circuit_id", params.circuitId)
    .eq("conditions", params.conditions)
    .maybeSingle();

  if (fetchErr) throw new Error(`Failed to check fm setup memory: ${fetchErr.message}`);

  if (existing && existing.lowest_rule_break < params.lowestRuleBreak) {
    return;
  }

  const { error: upsertErr } = await supabase
    .schema("pitboss")
    .from("fm_setup_memory")
    .upsert(
      {
        circuit_id: params.circuitId,
        conditions: params.conditions,
        setup_values: params.setupValues,
        lowest_rule_break: params.lowestRuleBreak,
        possible_setups: params.possibleSetups,
        sample_count: (existing?.sample_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "circuit_id,conditions" },
    );

  if (upsertErr) throw new Error(`Failed to upsert fm setup memory: ${upsertErr.message}`);
}
