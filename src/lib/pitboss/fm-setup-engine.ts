// File: src/lib/pitboss/fm-setup-engine.ts
//
// Pure logic for the F1 Manager setup solver. No Supabase calls in here —
// routes fetch pitboss.fm_setup_params ranges and pass them in, same
// convention as setup-engine.ts for the F1 25 generator.
//
// This is a from-scratch TypeScript port of the algorithm published at
// f1setup.it (iebb/F1Manager-Calc, MIT licensed) — reimplemented against
// pitboss's own schema and coding conventions rather than copied, but the
// coefficient matrices and breakpoint constants below are the actual game
// physics constants and must match the source exactly, not approximations.
//
// Core idea: five setup sliders (Front Angle, Rear Angle, Anti-Roll,
// Tyre Camber, Toe-Out) linearly combine into five performance biases
// (Oversteer, Braking, Cornering, Traction, Straights). Practice feedback
// on each bias ("optimal"/"great"/"good"/"bad"/"bad+"/"bad-") is a
// constraint, not a bound — every feedback point ever given is kept and
// re-validated against every candidate setup on each search. The search
// walks the full grid of ~1,000,000 valid setups, pruning branches whose
// running rule-break count already exceeds the best candidate found.

export type FmSetupParamKey =
  | "front_wing_angle"
  | "rear_wing_angle"
  | "anti_roll_bar"
  | "tyre_camber"
  | "toe_out";

export type FmBiasKey =
  | "oversteer"
  | "braking"
  | "cornering"
  | "traction"
  | "straights";

export type FmFeedbackValue =
  | "optimal"
  | "great"
  | "good"
  | "bad"
  | "bad+"
  | "bad-"
  | "unknown";

export interface FmFeedbackPoint {
  value: number; // the computed bias (0-1) at the moment this feedback was given
  feedback: FmFeedbackValue;
}

export type FmFeedbackByBias = Record<FmBiasKey, FmFeedbackPoint[]>;

export interface FmParamRange {
  param_key: FmSetupParamKey;
  min_value: number;
  max_value: number;
  step: number;
}

// Fixed order both arrays are indexed by throughout this file — matches the
// source's index convention exactly, since the effect matrices below are
// only valid in this order.
export const FM_SETUP_PARAM_ORDER: FmSetupParamKey[] = [
  "front_wing_angle",
  "rear_wing_angle",
  "anti_roll_bar",
  "tyre_camber",
  "toe_out",
];

export const FM_BIAS_ORDER: FmBiasKey[] = [
  "oversteer",
  "braking",
  "cornering",
  "traction",
  "straights",
];

// ---------------------------------------------------------------------------
// Game physics constants — DO NOT approximate. Sourced from f1setup.it's
// consts/params.js (CarSetupParams / BiasParams). effect[i] within a setup
// param's row is that param's contribution to bias index i; effect[j] within
// a bias row is that bias's sensitivity to setup param index j. Both express
// the same 5x5 linear map, just transposed for convenience at each call site.
// ---------------------------------------------------------------------------

/** Each setup param's contribution to each of the 5 biases, in FM_BIAS_ORDER. */
const CAR_SETUP_EFFECT: Record<FmSetupParamKey, number[]> = {
  front_wing_angle: [99 / 32, -3 / 8, -3 / 2, 9 / 32, -115 / 64],
  rear_wing_angle: [-11 / 32, 1 / 24, 1 / 6, -1 / 32, -175 / 192],
  anti_roll_bar: [7 / 16, 1 / 4, 1, 37 / 16, 25 / 32],
  tyre_camber: [-53 / 16, 23 / 12, 23 / 3, 17 / 16, 415 / 96],
  toe_out: [-33 / 32, 163 / 24, 43 / 6, -3 / 32, 755 / 192],
};

/** Each bias's offset and its sensitivity to each of the 5 setup params, in FM_SETUP_PARAM_ORDER. */
const BIAS_PARAMS: Record<FmBiasKey, { offset: number; effect: number[] }> = {
  oversteer: { offset: 0.5, effect: [0.4, -0.4, -0.1, 0.1, 0] },
  braking: { offset: 0.45, effect: [-0.2, 0.2, 0.15, -0.25, 0.2] },
  cornering: { offset: 0.2, effect: [0.3, 0.25, -0.15, 0.25, -0.05] },
  traction: { offset: 0.25, effect: [-0.15, 0.25, 0.5, -0.1, 0] },
  straights: { offset: 1, effect: [-0.1, -0.9, 0, 0, 0] },
};

// Only Toe-Out (index 4) has a nonzero effect on Braking (1) and Cornering (2);
// Straights (4) only depends on Front+Rear Angle (0,1); Oversteer (0) and
// Traction (3) don't depend on Toe-Out at all. This is what makes the
// pruning schedule below valid — it is a direct consequence of the zeros
// in BIAS_PARAMS above, not an arbitrary ordering choice.

export const MAX_SETUP_CANDIDATES = 99;
export const EPS = 1e-6;
export const OPTIMAL_BREAKPOINT = 0.007;
export const GREAT_BREAKPOINT = 0.04 + EPS;
export const GOOD_BREAKPOINT = 0.1 + EPS;
const ERROR_CONST = 1e20;
const BIAS_ROUNDING = 56000;

// ---------------------------------------------------------------------------
// Normalization — ranges are data-driven (from pitboss.fm_setup_params),
// coefficients are not. A raw slider value must be converted to its
// normalized step-fraction (0-1) before any bias math, since the effect
// coefficients are calibrated against that normalized space, not physical
// units.
// ---------------------------------------------------------------------------

function stepsFor(range: FmParamRange): number {
  return Math.round((range.max_value - range.min_value) / range.step);
}

export function rawToStepIndex(raw: number, range: FmParamRange): number {
  const steps = stepsFor(range);
  const idx = Math.round((raw - range.min_value) / range.step);
  return Math.min(steps, Math.max(0, idx));
}

export function stepIndexToRaw(stepIndex: number, range: FmParamRange): number {
  return range.min_value + stepIndex * range.step;
}

export function rawToNormalized(raw: number, range: FmParamRange): number {
  const steps = stepsFor(range);
  if (steps === 0) return 0;
  return rawToStepIndex(raw, range) / steps;
}

export function normalizedToRaw(v: number, range: FmParamRange): number {
  const steps = stepsFor(range);
  const stepIndex = Math.round(v * steps);
  return stepIndexToRaw(stepIndex, range);
}

function rangesByKey(ranges: FmParamRange[]): Record<FmSetupParamKey, FmParamRange> {
  const map = {} as Record<FmSetupParamKey, FmParamRange>;
  for (const r of ranges) map[r.param_key] = r;
  return map;
}

// ---------------------------------------------------------------------------
// setupToBias — the core linear transform, in normalized (0-1) space.
// ---------------------------------------------------------------------------

export function setupToBias(
  normalizedSetup: number[], // ordered per FM_SETUP_PARAM_ORDER
): number[] {
  // ordered per FM_BIAS_ORDER
  return FM_BIAS_ORDER.map((biasKey) => {
    const { offset, effect } = BIAS_PARAMS[biasKey];
    const raw = normalizedSetup.reduce((sum, v, i) => sum + v * effect[i], offset);
    return Math.round(raw * BIAS_ROUNDING) / BIAS_ROUNDING;
  });
}

/** Neutral anchor bias (each bias's base offset, no setup applied yet) — used when a driver has no prior setup to anchor the search's tie-breaking distance against. */
export function neutralAnchorBias(): number[] {
  return FM_BIAS_ORDER.map((key) => BIAS_PARAMS[key].offset);
}

/** Convenience wrapper taking/returning keyed objects instead of ordered arrays. */
export function setupToBiasKeyed(
  rawSetup: Record<FmSetupParamKey, number>,
  ranges: FmParamRange[],
): Record<FmBiasKey, number> {
  const rbk = rangesByKey(ranges);
  const normalized = FM_SETUP_PARAM_ORDER.map((key) => rawToNormalized(rawSetup[key], rbk[key]));
  const biasArr = setupToBias(normalized);
  const out = {} as Record<FmBiasKey, number>;
  FM_BIAS_ORDER.forEach((key, i) => (out[key] = biasArr[i]));
  return out;
}

// ---------------------------------------------------------------------------
// validateFeedbackBreaks — score a candidate bias vector against every
// feedback point recorded so far. A feedback point "breaks" if the
// candidate's bias for that category falls outside the band its feedback
// claims. Short-circuits as soon as maxBreaks is exceeded.
// ---------------------------------------------------------------------------

export function validateFeedbackBreaks(
  biasVector: number[], // ordered per FM_BIAS_ORDER
  feedbackByBias: FmFeedbackByBias,
  maxBreaks: number,
  validateIndices: number[] = [0, 1, 2, 3, 4],
): number {
  let ruleBreaks = 0;
  for (const idx of validateIndices) {
    const x = biasVector[idx];
    const biasKey = FM_BIAS_ORDER[idx];
    for (const fb of feedbackByBias[biasKey] ?? []) {
      const dx = Math.abs(x - fb.value);
      const f = fb.feedback;
      if (f === "unknown") continue;
      const breaks =
        (f === "bad" && dx < GOOD_BREAKPOINT) ||
        (f === "bad+" && fb.value - x < GOOD_BREAKPOINT) ||
        (f === "bad-" && fb.value - x > -GOOD_BREAKPOINT) ||
        (f === "good" && (dx > GOOD_BREAKPOINT || dx < GREAT_BREAKPOINT)) ||
        (f === "great" && (dx > GREAT_BREAKPOINT || dx < OPTIMAL_BREAKPOINT)) ||
        (f === "optimal" && dx >= OPTIMAL_BREAKPOINT);
      if (breaks) {
        ruleBreaks += 1;
        if (ruleBreaks > maxBreaks) return ruleBreaks;
      }
    }
  }
  return ruleBreaks;
}

// ---------------------------------------------------------------------------
// nearestSetup — the branch-and-bound search over the full setup grid.
// Pruning schedule (fixed by the zeros in BIAS_PARAMS, see note above):
//   after Front+Rear Angle  -> Straights (idx 4) fully determined
//   after Anti-Roll+Camber  -> Oversteer (0) + Traction (3) fully determined
//   after Toe-Out           -> Braking (1) + Cornering (2) fully determined
// ---------------------------------------------------------------------------

export interface NearestSetupCandidate {
  /** Raw physical values, ordered per FM_SETUP_PARAM_ORDER. */
  setup: number[];
  diff: number;
}

export interface NearestSetupResult {
  best: number[] | null; // raw physical values, ordered per FM_SETUP_PARAM_ORDER
  possibleSetups: number;
  lowestRuleBreak: number;
  candidates: NearestSetupCandidate[]; // top MAX_SETUP_CANDIDATES, sorted by diff
}

export function nearestSetup(params: {
  ranges: FmParamRange[];
  feedbackByBias: FmFeedbackByBias;
  /** Anchor bias vector (ordered per FM_BIAS_ORDER) to rank tied candidates against — typically the driver's current setup's computed bias. */
  anchorBias: number[];
}): NearestSetupResult {
  const { feedbackByBias, anchorBias } = params;
  const rbk = rangesByKey(params.ranges);
  const rangesOrdered = FM_SETUP_PARAM_ORDER.map((key) => rbk[key]);
  const stepsOrdered = rangesOrdered.map(stepsFor);

  let nearestResult: number[] | null = null;
  let nearestDiff = ERROR_CONST;
  let lowestRuleBreak = 15;
  let possibleSetups = 0;
  let candidateList: NearestSetupCandidate[] = [];

  const si = [0, 0, 0, 0, 0];
  const v = [0, 0, 0, 0, 0];
  const bias = FM_BIAS_ORDER.map((key) => BIAS_PARAMS[key].offset);

  // IMPORTANT: this must be the forward (setup -> bias) matrix, i.e.
  // BIAS_PARAMS[bias].effect[setupParam] — the same coefficients setupToBias
  // uses — NOT CAR_SETUP_EFFECT, which is a separately-precomputed inverse
  // (bias -> setup) matrix meant only for a closed-form biasToSetup, and is
  // numerically wrong to use here. effectOrdered[j][i] = bias i's
  // sensitivity to setup param j, transposed from BIAS_PARAMS for this
  // loop's per-setup-param-level access pattern.
  const effectOrdered: number[][] = FM_SETUP_PARAM_ORDER.map((_key, j) =>
    FM_BIAS_ORDER.map((biasKey) => BIAS_PARAMS[biasKey].effect[j]),
  );

  for (si[0] = 0; si[0] <= stepsOrdered[0]; si[0]++) {
    v[0] = si[0] / stepsOrdered[0];
    for (let i = 0; i < 5; i++) bias[i] += effectOrdered[0][i] * v[0];

    for (si[1] = 0; si[1] <= stepsOrdered[1]; si[1]++) {
      v[1] = si[1] / stepsOrdered[1];
      for (let i = 0; i < 5; i++) bias[i] += effectOrdered[1][i] * v[1];

      // Straights (idx 4) is fully determined here.
      const breaks4 = validateFeedbackBreaks(bias, feedbackByBias, lowestRuleBreak, [4]);
      if (breaks4 <= lowestRuleBreak) {
        for (si[2] = 0; si[2] <= stepsOrdered[2]; si[2]++) {
          v[2] = si[2] / stepsOrdered[2];
          for (let i = 0; i < 5; i++) bias[i] += effectOrdered[2][i] * v[2];

          for (si[3] = 0; si[3] <= stepsOrdered[3]; si[3]++) {
            v[3] = si[3] / stepsOrdered[3];
            for (let i = 0; i < 5; i++) bias[i] += effectOrdered[3][i] * v[3];

            // Oversteer (0) + Traction (3) fully determined here.
            const breaks03 = validateFeedbackBreaks(
              bias,
              feedbackByBias,
              lowestRuleBreak - breaks4,
              [0, 3],
            );
            const partialBreaks = breaks4 + breaks03;
            if (partialBreaks <= lowestRuleBreak) {
              for (si[4] = 0; si[4] <= stepsOrdered[4]; si[4]++) {
                v[4] = si[4] / stepsOrdered[4];
                for (let i = 0; i < 5; i++) {
                  bias[i] += effectOrdered[4][i] * v[4];
                  bias[i] = Math.round(bias[i] * BIAS_ROUNDING) / BIAS_ROUNDING;
                }

                // Braking (1) + Cornering (2) fully determined here — the
                // only two biases with nonzero sensitivity to Toe-Out.
                const breaks12 = validateFeedbackBreaks(
                  bias,
                  feedbackByBias,
                  lowestRuleBreak - partialBreaks,
                  [1, 2],
                );
                const ruleBreaks = partialBreaks + breaks12;

                if (ruleBreaks <= lowestRuleBreak) {
                  if (ruleBreaks < lowestRuleBreak) {
                    lowestRuleBreak = ruleBreaks;
                    possibleSetups = 0;
                    nearestDiff = ERROR_CONST;
                    nearestResult = null;
                    candidateList = [];
                  }

                  const rawSetup = v.map((x, idx) => stepIndexToRaw(si[idx], rangesOrdered[idx]));
                  const diff = bias.reduce(
                    (sum, x, idx) => sum + Math.min(Math.abs(x - anchorBias[idx]), 0.2) * 100,
                    0,
                  );

                  if (diff < nearestDiff) {
                    nearestDiff = diff;
                    nearestResult = rawSetup;
                  }
                  possibleSetups++;

                  if (
                    candidateList.length < MAX_SETUP_CANDIDATES ||
                    diff < candidateList[MAX_SETUP_CANDIDATES - 1].diff
                  ) {
                    candidateList.push({ setup: rawSetup, diff });
                    candidateList = candidateList
                      .sort((a, b) => a.diff - b.diff)
                      .slice(0, MAX_SETUP_CANDIDATES);
                  }
                }

                for (let i = 0; i < 5; i++) bias[i] -= effectOrdered[4][i] * v[4];
              }
            }
            for (let i = 0; i < 5; i++) bias[i] -= effectOrdered[3][i] * v[3];
          }
          for (let i = 0; i < 5; i++) bias[i] -= effectOrdered[2][i] * v[2];
        }
      }
      for (let i = 0; i < 5; i++) bias[i] -= effectOrdered[1][i] * v[1];
    }
    for (let i = 0; i < 5; i++) bias[i] -= effectOrdered[0][i] * v[0];
  }

  return {
    best: nearestResult,
    possibleSetups,
    lowestRuleBreak,
    candidates: candidateList.sort((a, b) => a.diff - b.diff).slice(0, MAX_SETUP_CANDIDATES),
  };
}

// ---------------------------------------------------------------------------
// optimalRanges — per-bias indicator of which positions are still consistent
// with all recorded feedback for that bias alone. Cheap UI hint (e.g. a
// shaded band on a slider) distinct from the full 5-param joint search above.
// ---------------------------------------------------------------------------

type Interval = [number, number];

function clampSet(intervals: Interval[]): Interval[] {
  return intervals
    .map(([a, b]): Interval => [Math.max(0, a), Math.min(1, b)])
    .filter(([a, b]) => b - a > 1e-9);
}

function allowedIntervalsFor(fb: FmFeedbackPoint): Interval[] {
  const v = fb.value;
  const O = OPTIMAL_BREAKPOINT;
  const G = GREAT_BREAKPOINT;
  const D = GOOD_BREAKPOINT;
  switch (fb.feedback) {
    case "optimal":
      return clampSet([[v - O, v + O]]);
    case "great":
      return clampSet([
        [v - G, v - O],
        [v + O, v + G],
      ]);
    case "good":
      return clampSet([
        [v - D, v - G],
        [v + G, v + D],
      ]);
    case "bad":
      return clampSet([
        [0, v - D],
        [v + D, 1],
      ]);
    case "bad+":
      return clampSet([[0, v - D]]);
    case "bad-":
      return clampSet([[v + D, 1]]);
    default:
      return [[0, 1]];
  }
}

function mergeSet(intervals: Interval[]): Interval[] {
  if (intervals.length <= 1) return intervals;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [[...sorted[0]] as Interval];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push([...sorted[i]] as Interval);
  }
  return merged;
}

function intersectSets(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi - lo > 1e-9) out.push([lo, hi]);
    }
  }
  return mergeSet(out);
}

/** Disjoint [lo,hi] ranges (in 0-1 bias space) consistent with every recorded feedback point for one bias. Empty array = contradictory feedback. */
export function optimalRanges(feedbackForBias: FmFeedbackPoint[]): Interval[] {
  let ranges: Interval[] = [[0, 1]];
  for (const fb of feedbackForBias ?? []) {
    if (!fb || fb.feedback === "unknown") continue;
    ranges = intersectSets(ranges, allowedIntervalsFor(fb));
    if (ranges.length === 0) break;
  }
  return ranges;
}
