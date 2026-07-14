// File: src/lib/pitboss/setup-engine.ts
//
// Pure aggregation logic for turning multiple community/driver setup
// submissions into a single recommended setup, plus deterministic and
// LLM-driven delta layers on top. No Supabase calls in here — routes fetch
// rows and pass them in, which keeps this testable and reusable.

export type SessionType = "race" | "qualifying" | "sprint" | "time_trial" | "practice";

export interface ParamRange {
  param_key: string;
  param_group: string;
  min_value: number;
  max_value: number;
  default_value: number;
  step: number;
  unit: string;
}

export interface TrackOverride {
  param_key: string;
  override_min: number | null;
  override_max: number | null;
  override_default: number | null;
  weight: number | null;
  basis: string | null;
}

export interface SetupSubmissionInput {
  id: string;
  league_id: string | null;
  setup_values: Record<string, number>;
  confidence: number; // 0-1
  verified: boolean;
  source_name: string | null;
  source_url: string | null;
}

export interface ParamContributor {
  submission_id: string;
  source_name: string | null;
  value: number;
  weight: number;
}

export interface ParamRationale {
  value: number;
  unit: string;
  origin:
    | "weighted_average"
    | "override_default"
    | "class_default"
    | "feedback_adjusted"
    | "trait_adjusted"
    | "session_adjusted";
  override_applied: boolean;
  contributors: ParamContributor[];
  adjustment?: {
    delta: number;
    reason: string;
    clamped: boolean;
  };
}

export interface GeneratedRecommendation {
  generated_setup: Record<string, number>;
  rationale: Record<string, ParamRationale>;
  confidence: number;
  baseline_used: boolean;
  model: string;
}

const MODEL_TAG = "weighted-average-v1";

function decimalsFor(step: number): number {
  const s = step.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundToStep(value: number, min: number, step: number): number {
  if (step <= 0) return value;
  const steps = Math.round((value - min) / step);
  const result = min + steps * step;
  return Number(result.toFixed(decimalsFor(step)));
}

function submissionWeight(
  sub: SetupSubmissionInput,
  requestingLeagueId: string | null
): number {
  let weight = Math.max(sub.confidence, 0.01);
  if (sub.verified) weight *= 1.5;
  if (requestingLeagueId && sub.league_id === requestingLeagueId) weight *= 1.3;
  return weight;
}

export function buildRecommendation(params: {
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  submissions: SetupSubmissionInput[];
  requestingLeagueId: string | null;
}): GeneratedRecommendation {
  const { paramRanges, overrides, submissions, requestingLeagueId } = params;

  const overrideByKey = new Map(overrides.map((o) => [o.param_key, o]));
  const generated_setup: Record<string, number> = {};
  const rationale: Record<string, ParamRationale> = {};

  for (const range of paramRanges) {
    const override = overrideByKey.get(range.param_key);
    const min = override?.override_min ?? range.min_value;
    const max = override?.override_max ?? range.max_value;

    const contributors: ParamContributor[] = [];
    let weightedSum = 0;
    let weightTotal = 0;

    for (const sub of submissions) {
      const raw = sub.setup_values[range.param_key];
      if (typeof raw !== "number" || Number.isNaN(raw)) continue;
      const w = submissionWeight(sub, requestingLeagueId);
      weightedSum += raw * w;
      weightTotal += w;
      contributors.push({
        submission_id: sub.id,
        source_name: sub.source_name,
        value: raw,
        weight: Number(w.toFixed(3)),
      });
    }

    let rawValue: number;
    let origin: ParamRationale["origin"];

    if (weightTotal > 0) {
      rawValue = weightedSum / weightTotal;
      origin = "weighted_average";
    } else if (override?.override_default != null) {
      rawValue = override.override_default;
      origin = "override_default";
    } else {
      rawValue = range.default_value;
      origin = "class_default";
    }

    const clamped = clamp(rawValue, min, max);
    const finalValue = roundToStep(clamped, min, range.step);

    generated_setup[range.param_key] = finalValue;
    rationale[range.param_key] = {
      value: finalValue,
      unit: range.unit,
      origin,
      override_applied: Boolean(override),
      contributors,
    };
  }

  const baseline_used = submissions.length === 0;

  let confidence: number;
  if (baseline_used) {
    confidence = 0.2;
  } else {
    const avgConfidence =
      submissions.reduce((sum, s) => sum + s.confidence, 0) / submissions.length;
    const anyVerified = submissions.some((s) => s.verified);
    confidence = clamp(
      avgConfidence + 0.05 * (submissions.length - 1) + (anyVerified ? 0.1 : 0),
      0,
      0.95
    );
  }

  return {
    generated_setup,
    rationale,
    confidence: Number(confidence.toFixed(2)),
    baseline_used,
    model: MODEL_TAG,
  };
}

// ---------------------------------------------------------------------------
// Shared delta-application core
// ---------------------------------------------------------------------------
//
// The LLM feedback loop, the deterministic team/driver trait bias, and the
// deterministic session-type bias all move a generated setup by applying a
// per-param delta on top of the current value, through the exact same
// clamp/round/override pipeline.

export interface DeltaAdjustment {
  param_key: string;
  delta: number;
  reason: string;
}

function applyDeltas(params: {
  base: GeneratedRecommendation;
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  adjustments: DeltaAdjustment[];
  origin: ParamRationale["origin"];
  maxDeltaFraction: number;
  modelSuffix: string;
  confidenceMultiplier: number;
}): GeneratedRecommendation {
  const {
    base,
    paramRanges,
    overrides,
    adjustments,
    origin,
    maxDeltaFraction,
    modelSuffix,
    confidenceMultiplier,
  } = params;

  const overrideByKey = new Map(overrides.map((o) => [o.param_key, o]));
  const rangeByKey = new Map(paramRanges.map((r) => [r.param_key, r]));
  const adjustmentByKey = new Map(adjustments.map((a) => [a.param_key, a]));

  const generated_setup: Record<string, number> = { ...base.generated_setup };
  const rationale: Record<string, ParamRationale> = { ...base.rationale };

  for (const [key, adj] of adjustmentByKey) {
    const range = rangeByKey.get(key);
    const priorRationale = base.rationale[key];
    if (!range || !priorRationale) continue;

    const override = overrideByKey.get(key);
    const min = override?.override_min ?? range.min_value;
    const max = override?.override_max ?? range.max_value;
    const span = max - min;
    const deltaCap = span * maxDeltaFraction;

    const requestedDelta = adj.delta;
    const cappedDelta = clamp(requestedDelta, -deltaCap, deltaCap);
    const wasCapped = cappedDelta !== requestedDelta;

    const currentValue = generated_setup[key] ?? range.default_value;
    const proposed = currentValue + cappedDelta;
    const clampedToRange = clamp(proposed, min, max);
    const finalValue = roundToStep(clampedToRange, min, range.step);
    const clampedOverall = wasCapped || clampedToRange !== proposed;

    generated_setup[key] = finalValue;
    rationale[key] = {
      ...priorRationale,
      value: finalValue,
      origin,
      adjustment: {
        delta: Number((finalValue - currentValue).toFixed(decimalsFor(range.step))),
        reason: adj.reason,
        clamped: clampedOverall,
      },
    };
  }

  const confidence = base.baseline_used
    ? base.confidence
    : Number(clamp(base.confidence * confidenceMultiplier, 0.1, 0.95).toFixed(2));

  return {
    generated_setup,
    rationale,
    confidence,
    baseline_used: base.baseline_used,
    model: `${base.model}+${modelSuffix}`,
  };
}

// ---------------------------------------------------------------------------
// Feedback-driven adjustment (LLM)
// ---------------------------------------------------------------------------

const MAX_FEEDBACK_DELTA_FRACTION = 0.25;

export type FeedbackAdjustment = DeltaAdjustment;

export function applyFeedbackAdjustments(params: {
  base: GeneratedRecommendation;
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  adjustments: FeedbackAdjustment[];
}): GeneratedRecommendation {
  return applyDeltas({
    ...params,
    origin: "feedback_adjusted",
    maxDeltaFraction: MAX_FEEDBACK_DELTA_FRACTION,
    modelSuffix: "feedback",
    confidenceMultiplier: 0.95,
  });
}

// ---------------------------------------------------------------------------
// Team & driver trait bias (deterministic)
// ---------------------------------------------------------------------------
//
// Team characteristics (car_class_teams, -1..1) and career-mode driver stats
// (Pace/Racecraft/Awareness/Experience, 0-99, EA's F1 25 scale) each nudge
// the generated setup by a small fraction of each param's legal span. This
// is a first-pass tuning table, not derived telemetry — expect to adjust
// these coefficients once they've been driven.

const MAX_TRAIT_DELTA_FRACTION = 0.15;

export interface TeamTraits {
  aero_efficiency: number;
  engine_power: number;
  mechanical_grip: number;
  reliability: number;
  drag_efficiency: number;
  tyre_wear_management: number;
}

export interface DriverStats {
  pace: number; // 0-99
  racecraft: number; // 0-99
  awareness: number; // 0-99
  experience: number; // 0-99
}

type ParamWeightMap = Partial<Record<string, number>>;

const TEAM_TRAIT_PARAM_MAP: Record<keyof TeamTraits, ParamWeightMap> = {
  aero_efficiency: { front_wing_aero: -0.06, rear_wing_aero: -0.06 },
  engine_power: { rear_wing_aero: -0.05 },
  mechanical_grip: {
    front_arb: -0.06,
    rear_arb: -0.06,
    front_ride_height: -0.04,
    rear_ride_height: -0.04,
  },
  reliability: { brake_pressure: 0.03 },
  drag_efficiency: { front_wing_aero: 0.05, rear_wing_aero: 0.05 },
  tyre_wear_management: {
    front_camber: -0.05,
    rear_camber: -0.05,
    front_tyre_pressure: -0.03,
    rear_tyre_pressure: -0.03,
  },
};

const DRIVER_STAT_PARAM_MAP: Record<keyof DriverStats, ParamWeightMap> = {
  pace: {
    front_wing_aero: -0.04,
    rear_wing_aero: -0.04,
    front_arb: -0.03,
    rear_arb: -0.03,
  },
  racecraft: { diff_adjustment_on_throttle: -0.04, front_brake_bias: 0.02 },
  awareness: { rear_toe_in: 0.03, front_toe_out: -0.03 },
  experience: { front_ride_height: -0.03, rear_ride_height: -0.03, brake_pressure: 0.02 },
};

function normalizeDriverStat(value: number): number {
  return clamp((value - 50) / 49, -1, 1);
}

function accumulateWeightedDeltas(params: {
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  sources: Array<{ label: string; normalizedValue: number; map: ParamWeightMap }>;
}): DeltaAdjustment[] {
  const { paramRanges, overrides, sources } = params;
  const overrideByKey = new Map(overrides.map((o) => [o.param_key, o]));
  const rangeByKey = new Map(paramRanges.map((r) => [r.param_key, r]));

  const totals = new Map<string, { delta: number; reasons: string[] }>();

  for (const source of sources) {
    if (source.normalizedValue === 0) continue;
    for (const [paramKey, weightPerUnit] of Object.entries(source.map)) {
      if (!weightPerUnit) continue;
      const range = rangeByKey.get(paramKey);
      if (!range) continue;
      const override = overrideByKey.get(paramKey);
      const min = override?.override_min ?? range.min_value;
      const max = override?.override_max ?? range.max_value;
      const span = max - min;

      const delta = span * weightPerUnit * source.normalizedValue;
      const entry = totals.get(paramKey) ?? { delta: 0, reasons: [] };
      entry.delta += delta;
      entry.reasons.push(source.label);
      totals.set(paramKey, entry);
    }
  }

  return Array.from(totals.entries()).map(([param_key, { delta, reasons }]) => ({
    param_key,
    delta,
    reason: `Adjusted for ${reasons.join(", ")}`,
  }));
}

export function applyTeamAndDriverBias(params: {
  base: GeneratedRecommendation;
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  teamTraits?: TeamTraits | null;
  driverStats?: DriverStats | null;
}): GeneratedRecommendation {
  const { base, paramRanges, overrides, teamTraits, driverStats } = params;

  const sources: Array<{ label: string; normalizedValue: number; map: ParamWeightMap }> = [];

  if (teamTraits) {
    for (const key of Object.keys(TEAM_TRAIT_PARAM_MAP) as Array<keyof TeamTraits>) {
      sources.push({
        label: `team ${key.replace(/_/g, " ")}`,
        normalizedValue: clamp(teamTraits[key] ?? 0, -1, 1),
        map: TEAM_TRAIT_PARAM_MAP[key],
      });
    }
  }

  if (driverStats) {
    for (const key of Object.keys(DRIVER_STAT_PARAM_MAP) as Array<keyof DriverStats>) {
      sources.push({
        label: `driver ${key}`,
        normalizedValue: normalizeDriverStat(driverStats[key] ?? 50),
        map: DRIVER_STAT_PARAM_MAP[key],
      });
    }
  }

  if (sources.length === 0) return base;

  const adjustments = accumulateWeightedDeltas({ paramRanges, overrides, sources });
  if (adjustments.length === 0) return base;

  return applyDeltas({
    base,
    paramRanges,
    overrides,
    adjustments,
    origin: "trait_adjusted",
    maxDeltaFraction: MAX_TRAIT_DELTA_FRACTION,
    modelSuffix: "trait-bias-v1",
    confidenceMultiplier: 1.0,
  });
}

// ---------------------------------------------------------------------------
// Session-type bias (deterministic) — NEW
// ---------------------------------------------------------------------------
//
// Reuses the same accumulateWeightedDeltas/applyDeltas core as team/driver
// bias above. Session type isn't a continuous trait, so it's modeled as a
// single always-on source (normalizedValue: 1) whose weight map already
// encodes the full desired shift fraction for that specific session.
//
// Qualifying/time trial favor a lower, stiffer, more aggressive car for a
// single fast lap; race favors stability and tyre/fuel management; sprint
// sits between race and qualifying; practice stays neutral (empty map) so
// drivers see the same baseline they'll refine for whatever session comes
// next.

const MAX_SESSION_DELTA_FRACTION = 0.25;

const SESSION_PARAM_MAP: Record<SessionType, ParamWeightMap> = {
  qualifying: {
    front_ride_height: -0.15,
    rear_ride_height: -0.15,
    front_suspension: 0.10,
    rear_suspension: 0.10,
    front_arb: 0.08,
    rear_arb: 0.08,
    diff_adjustment_on_throttle: 0.10,
    brake_pressure: 0.05,
    front_wing_aero: -0.05,
    rear_wing_aero: -0.05,
  },
  time_trial: {
    front_ride_height: -0.20,
    rear_ride_height: -0.20,
    front_suspension: 0.15,
    rear_suspension: 0.15,
    front_arb: 0.12,
    rear_arb: 0.12,
    diff_adjustment_on_throttle: 0.15,
    brake_pressure: 0.10,
    front_wing_aero: -0.05,
    rear_wing_aero: -0.05,
  },
  sprint: {
    front_ride_height: -0.08,
    rear_ride_height: -0.08,
    front_suspension: 0.05,
    rear_suspension: 0.05,
    front_arb: 0.04,
    rear_arb: 0.04,
    diff_adjustment_on_throttle: 0.03,
    brake_pressure: 0.02,
    front_wing_aero: 0.02,
    rear_wing_aero: 0.02,
  },
  race: {
    front_ride_height: 0.05,
    rear_ride_height: 0.05,
    front_suspension: -0.05,
    rear_suspension: -0.05,
    front_arb: -0.04,
    rear_arb: -0.04,
    diff_adjustment_on_throttle: -0.05,
    brake_pressure: -0.05,
    front_wing_aero: 0.05,
    rear_wing_aero: 0.05,
  },
  practice: {},
};

export function applySessionBias(params: {
  base: GeneratedRecommendation;
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  sessionType: SessionType;
}): GeneratedRecommendation {
  const { base, paramRanges, overrides, sessionType } = params;

  const map = SESSION_PARAM_MAP[sessionType];
  if (!map || Object.keys(map).length === 0) return base;

  const adjustments = accumulateWeightedDeltas({
    paramRanges,
    overrides,
    sources: [{ label: `session ${sessionType}`, normalizedValue: 1, map }],
  });
  if (adjustments.length === 0) return base;

  return applyDeltas({
    base,
    paramRanges,
    overrides,
    adjustments,
    origin: "session_adjusted",
    maxDeltaFraction: MAX_SESSION_DELTA_FRACTION,
    modelSuffix: "session-bias-v1",
    confidenceMultiplier: 1.0,
  });
}
