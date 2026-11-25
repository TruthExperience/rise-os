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
  CarFeelPreference,
  ParamWeightMap,
} from "./setup-engine";

function getSupabase() {
  return createAdminClient();
}

// Params the game does not expose for a car class, keyed by
// pitboss.car_classes.code. The UDP CarSetupData struct carries fields that
// the setup screen doesn't offer, so serving every seeded range row put
// impossible sliders in the submit form and impossible entries in generated
// setups:
//   - ballast: F1 23, F1 24 and F1 25 cars (including the F1 25 2026 Season
//     Pack) don't expose it (a captured setup carries only wings,
//     differential, geometry, suspension, brakes and tyre pressures), and F2
//     runs a spec chassis with a fixed weight distribution, so no F1 or F2
//     class exposes it. The 0-100% row is part of the blanket seed every
//     class received.
//   - engine_braking: only the 2026 Season Pack's 2026 F1 cars have it (a
//     50% baseline in every fast setup). F1 25's 2025 cars and the F2 cars
//     have no such setting, and F1 2023 predates the field entirely (f24.ts
//     records engineBraking as new in the F1 24 packet). F1_2026 keeps it,
//     but still has no ballast setting.
const UNSUPPORTED_PARAMS_BY_CAR_CLASS: Record<string, readonly string[]> = {
  // F1 23 has neither setting: engine braking arrived in F1 24, and ballast
  // is only a UDP field there, not a setup-screen slider.
  F1_2023: ["ballast", "engine_braking"],
  // F1 2024 keeps engine braking (the setting arrived in F1 24, see f24.ts)
  // but has no ballast setting either. Ballast is not seeded for the class;
  // the entry guards against a future blanket seed re-adding it.
  F1_2024: ["ballast"],
  F1_2025: ["ballast", "engine_braking"],
  // The 2026 Season Pack adds engine braking to the F1 25 setup screen but
  // still has no ballast slider.
  F1_2026: ["ballast"],
  // Each game's F1 World Car reuses that game's own F1 setup screen: F1 23
  // has no engine braking, F1 24 has engine braking but no ballast, and F1 25
  // has neither. Ranges are copied from the matching F1 class. F1_WORLD is
  // the F1 25 class and stays on its original code (league tiers reference it).
  F1_WORLD: ["ballast", "engine_braking"],
  F1_WORLD_F123: ["ballast", "engine_braking"],
  F1_WORLD_F124: ["ballast"],
  // F2 runs the spec chassis in every game, and engine braking is missing
  // from the F2 setup screen in F1 24 (simracingsetup's F1 24 F2 guide).
  F2_2023_F123: ["ballast", "engine_braking"],
  F2_2023_F124: ["ballast", "engine_braking"],
  F2_2024_F124: ["ballast", "engine_braking"],
  F2_2024_F125: ["ballast", "engine_braking"],
  F2_2025: ["ballast", "engine_braking"],
  F2_2026: ["ballast", "engine_braking"],
};

export async function fetchParamRanges(
  carClassId: string,
  sessionType: string
): Promise<ParamRange[]> {
  const supabase = getSupabase();
  const [rangesResult, carClassResult] = await Promise.all([
    supabase
      .schema("pitboss")
      .from("setup_parameter_ranges")
      .select("param_key, param_group, min_value, max_value, default_value, step, unit, applicable_session_types")
      .eq("car_class_id", carClassId),
    // Best-effort: if this lookup fails we keep every range row rather than
    // failing the whole request over a class-level exclusion.
    supabase
      .schema("pitboss")
      .from("car_classes")
      .select("code")
      .eq("id", carClassId)
      .maybeSingle(),
  ]);

  const { data, error } = rangesResult;
  if (error) throw new Error(`Failed to load param ranges: ${error.message}`);

  const unsupported = new Set(
    UNSUPPORTED_PARAMS_BY_CAR_CLASS[carClassResult.data?.code ?? ""] ?? []
  );

  return (data ?? [])
    .filter((r) => !unsupported.has(r.param_key))
    .filter((r) => !r.applicable_session_types || r.applicable_session_types.includes(sessionType))
    .map((r) => ({
      param_key: r.param_key,
      param_group: r.param_group,
      min_value: Number(r.min_value),
      max_value: Number(r.max_value),
      // r.default_value is genuinely nullable in the DB (several car
      // classes have no seeded default yet) — Number(null) === 0 in JS,
      // which silently turned a real gap into a fake "0 psi" / "0
      // degrees" default. Preserve null so callers (buildRecommendation,
      // SubmitSetupForm's slider init) can tell the difference between
      // "the default really is 0" and "there is no default yet."
      default_value: r.default_value != null ? Number(r.default_value) : null,
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

/**
 * The circuit's archetype tag (street_circuit, high_downforce_technical, ...).
 * Used as the fallback starter when a track has no community submissions: see
 * applyTrackArchetypeBias in setup-engine.ts. Null for a track that has no tag
 * yet, which the caller treats as "no archetype bias".
 */
export async function fetchTrackArchetype(trackId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("tracks")
    .select("archetype")
    .eq("id", trackId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load track archetype: ${error.message}`);
  return data?.archetype ?? null;
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
    .select("pace, racecraft, awareness, experience, focus")
    .eq("id", careerDriverId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load career driver stats: ${error.message}`);
  if (!data) return null;

  return {
    pace: Number(data.pace ?? 50),
    racecraft: Number(data.racecraft ?? 50),
    awareness: Number(data.awareness ?? 50),
    experience: Number(data.experience ?? 50),
    focus: Number(data.focus ?? 50),
  };
}


const CAR_FEEL_VALUES = [
  "loose_oversteer",
  "planted_understeer",
  "balanced",
  "aggressive_rotation",
  "stable_predictable",
] as const;

export interface DriverStyleProfileData {
  car_feel_preference: CarFeelPreference;
  preferred_race_length: string;
  assists: Record<string, unknown>;
  // LLM-generated from comparison_drivers + car_feel_notes (see the
  // `comparison_bias` action in /api/pitboss/llm/route.ts). Null/empty
  // until the driver has saved those freetext fields at least once since
  // that generation path was added. applyComparisonBias treats either
  // case as a no-op.
  comparison_bias: ParamWeightMap | null;
}

export async function fetchDriverStyleProfile(
  driverId: string
): Promise<DriverStyleProfileData | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("driver_style_profiles")
    .select("car_feel_preference, preferred_race_length, assists, comparison_bias")
    .eq("driver_id", driverId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load driver style profile: ${error.message}`);
  if (!data) return null;

  const pref = data.car_feel_preference as string;
  if (!CAR_FEEL_VALUES.includes(pref as CarFeelPreference)) {
    // DB has a CHECK constraint, so this should be unreachable in practice —
    // guarding anyway rather than trusting the cast silently.
    throw new Error(`Unexpected car_feel_preference value: ${pref}`);
  }

  const rawBias = data.comparison_bias as Record<string, unknown> | null;
  const comparisonBias: ParamWeightMap | null =
    rawBias && Object.keys(rawBias).length > 0 ? (rawBias as ParamWeightMap) : null;

  return {
    car_feel_preference: pref as CarFeelPreference,
    preferred_race_length: data.preferred_race_length,
    assists: (data.assists as Record<string, unknown>) ?? {},
    comparison_bias: comparisonBias,
  };
}
