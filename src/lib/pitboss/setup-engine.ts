// File: src/lib/pitboss/setup-engine.ts
//
// Pure aggregation logic for turning multiple community/driver setup
// submissions into a single recommended setup. No Supabase calls in here —
// the API route is responsible for fetching rows and passing them in, which
// keeps this testable and reusable (e.g. from a script or a cron job).

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
  origin: "weighted_average" | "override_default" | "class_default" | "feedback_adjusted";
  override_applied: boolean;
  contributors: ParamContributor[];
  /** Present only when this param was moved by driver feedback. */
  adjustment?: {
    delta: number;
    reason: string;
    clamped: boolean; // true if the LLM's requested delta was reduced to respect the per-round cap or the param's legal range
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

/**
 * Decimal precision implied by a step size, e.g. 0.01 -> 2, 1 -> 0.
 */
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

/**
 * Per-submission weight: base confidence, boosted for verified (admin-checked)
 * submissions, and further boosted if it came from the requesting league
 * specifically rather than the global/community pool.
 */
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
// Feedback-driven adjustment
// ---------------------------------------------------------------------------
//
// The LLM never invents raw setup values. It proposes a *delta* per param key
// plus a reason, in response to a driver's free-text feedback. This function
// is the only thing allowed to turn those deltas into actual numbers, and it
// applies the exact same clamp/round/override rules as buildRecommendation,
// so a feedback round can never push a param outside the car's legal range.

/** No single feedback round may move a param by more than this fraction of its legal span. */
const MAX_FEEDBACK_DELTA_FRACTION = 0.25;

export interface FeedbackAdjustment {
  param_key: string;
  delta: number;
  reason: string;
}

export function applyFeedbackAdjustments(params: {
  base: GeneratedRecommendation;
  paramRanges: ParamRange[];
  overrides: TrackOverride[];
  adjustments: FeedbackAdjustment[];
}): GeneratedRecommendation {
  const { base, paramRanges, overrides, adjustments } = params;

  const overrideByKey = new Map(overrides.map((o) => [o.param_key, o]));
  const rangeByKey = new Map(paramRanges.map((r) => [r.param_key, r]));
  const adjustmentByKey = new Map(adjustments.map((a) => [a.param_key, a]));

  const generated_setup: Record<string, number> = { ...base.generated_setup };
  const rationale: Record<string, ParamRationale> = { ...base.rationale };

  for (const [key, adj] of adjustmentByKey) {
    const range = rangeByKey.get(key);
    const priorRationale = base.rationale[key];
    if (!range || !priorRationale) continue; // LLM referenced a param that isn't valid for this car class — ignore it

    const override = overrideByKey.get(key);
    const min = override?.override_min ?? range.min_value;
    const max = override?.override_max ?? range.max_value;
    const span = max - min;
    const deltaCap = span * MAX_FEEDBACK_DELTA_FRACTION;

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
      origin: "feedback_adjusted",
      adjustment: {
        delta: Number((finalValue - currentValue).toFixed(decimalsFor(range.step))),
        reason: adj.reason,
        clamped: clampedOverall,
      },
    };
  }

  // A feedback round is a real revision, not fresh crowd data, so treat it as
  // slightly less certain than the recommendation it started from -- unless
  // that recommendation was already a pure baseline default, in which case
  // there's nothing to lose confidence in.
  const confidence = base.baseline_used
    ? base.confidence
    : Number(clamp(base.confidence * 0.95, 0.1, 0.95).toFixed(2));

  return {
    generated_setup,
    rationale,
    confidence,
    baseline_used: base.baseline_used,
    model: `${base.model}+feedback`,
  };
}
