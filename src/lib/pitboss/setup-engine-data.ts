// File: src/lib/pitboss/setup-engine-data.ts
//
// Shared fetch helpers for the setup engine. Kept separate from
// setup-engine.ts (which is pure logic, no I/O) so both the /recommend and
// /feedback routes pull param ranges / overrides / submissions / team traits
// / career driver stats the same way.

import { createAdminClient } from "@/lib/supabase/server";
import type {
  ParamRange,
  TrackOverride,
  SetupSubmissionInput,
  TeamTraits,
  DriverStats,
} from "./setup-engine";

function getSupabase() {
  return createAdminClient();
}

export async function fetchParamRanges(
  carClassId: string,
  sessionType: string
): Promise<ParamRange[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("setup_parameter_ranges")
    .select("param_key, param_group, min_value, max_value, default_value, step, unit, applicable_session_types")
    .eq("car_class_id", carClassId);

  if (error) throw new Error(`Failed to load param ranges: ${error.message}`);

  return (data ?? [])
    .filter((r) => !r.applicable_session_types || r.applicable_session_types.includes(sessionType))
    .map((r) => ({
      param_key: r.param_key,
      param_group: r.param_group,
      min_value: Number(r.min_value),
      max_value: Number(r.max_value),
      default_value: Number(r.default_value),
      step: Number(r.step),
      unit: r.unit,
    }));
}

export async function fetchOverrides(
  trackId: string,
  carClassId: string
): Promise<TrackOverride[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("track_setup_overrides")
    .select("param_key, override_min, override_max, override_default, weight, basis")
    .eq("track_id", trackId)
    .eq("car_class_id", carClassId);

  if (error) throw new Error(`Failed to load track overrides: ${error.message}`);

  return (data ?? []).map((o) => ({
    param_key: o.param_key,
    override_min: o.override_min == null ? null : Number(o.override_min),
    override_max: o.override_max == null ? null : Number(o.override_max),
    override_default: o.override_default == null ? null : Number(o.override_default),
    weight: o.weight == null ? null : Number(o.weight),
    basis: o.basis,
  }));
}

export async function fetchSubmissions(params: {
  trackId: string;
  carClassId: string;
  conditions: string;
  sessionType: string;
}): Promise<SetupSubmissionInput[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("setup_submissions")
    .select("id, league_id, setup_values, confidence, verified, source_name, source_url")
    .eq("track_id", params.trackId)
    .eq("car_class_id", params.carClassId)
    .eq("conditions", params.conditions)
    .eq("session_type", params.sessionType);

  if (error) throw new Error(`Failed to load setup submissions: ${error.message}`);

  return (data ?? []).map((s) => ({
    id: s.id,
    league_id: s.league_id,
    setup_values: s.setup_values as Record<string, number>,
    confidence: Number(s.confidence),
    verified: Boolean(s.verified),
    source_name: s.source_name,
    source_url: s.source_url,
  }));
}

export async function fetchTeamTraits(teamId: string): Promise<TeamTraits | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("car_class_teams")
    .select("aero_efficiency, engine_power, mechanical_grip, reliability, drag_efficiency, tyre_wear_management")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load team traits: ${error.message}`);
  if (!data) return null;

  return {
    aero_efficiency: Number(data.aero_efficiency ?? 0),
    engine_power: Number(data.engine_power ?? 0),
    mechanical_grip: Number(data.mechanical_grip ?? 0),
    reliability: Number(data.reliability ?? 0),
    drag_efficiency: Number(data.drag_efficiency ?? 0),
    tyre_wear_management: Number(data.tyre_wear_management ?? 0),
  };
}

export async function fetchCareerDriverStats(careerDriverId: string): Promise<DriverStats | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("career_mode_drivers")
    .select("pace, racecraft, awareness, experience")
    .eq("id", careerDriverId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load career driver stats: ${error.message}`);
  if (!data) return null;

  return {
    pace: Number(data.pace ?? 50),
    racecraft: Number(data.racecraft ?? 50),
    awareness: Number(data.awareness ?? 50),
    experience: Number(data.experience ?? 50),
  };
}
