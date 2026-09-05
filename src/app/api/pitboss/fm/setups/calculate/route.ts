import { NextRequest, NextResponse } from "next/server";
import {
  nearestSetup,
  setupToBiasKeyed,
  neutralAnchorBias,
  FM_BIAS_ORDER,
  FM_SETUP_PARAM_ORDER,
  MAX_SETUP_CANDIDATES,
  FmSetupParamKey,
  FmBiasKey,
  FmFeedbackValue,
} from "@/lib/pitboss/fm-setup-engine";
import {
  fetchFmParamRanges,
  fetchOrCreateFmSetupSession,
  updateFmSetupSession,
  logFmFeedback,
  fetchFmSetupMemory,
  upsertFmSetupMemory,
} from "@/lib/pitboss/fm-setup-engine-data";
import { getAuthedDriver } from "@/lib/getSupabaseUserId";

interface CalculateRequestBody {
  circuit_id: string;
  conditions: "dry" | "wet";
  driver_slot: 1 | 2;
  driver_slot_name?: string | null;
  // The setup the driver just tried in-game, if this call is reporting new
  // feedback on it. Omit to just re-run the search against existing
  // feedback (e.g. re-fetching candidates after a session was already
  // populated elsewhere).
  current_values?: Record<FmSetupParamKey, number>;
  // One feedback point per bias category being reported this call. Only
  // include the categories the driver actually gave feedback on.
  new_feedback?: Partial<Record<FmBiasKey, FmFeedbackValue>>;
  // Number of ranked candidates to return, capped at MAX_SETUP_CANDIDATES.
  // Defaults to 10 for normal UI calls; stewards/debug views can request up
  // to the full 99 already computed by the search.
  candidate_limit?: number;
}

export async function POST(req: NextRequest) {
  let body: CalculateRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    circuit_id,
    conditions,
    driver_slot,
    driver_slot_name = null,
    current_values,
    new_feedback,
    candidate_limit,
  } = body;

  if (!circuit_id || !conditions || !driver_slot) {
    return NextResponse.json(
      { error: "circuit_id, conditions, and driver_slot are required" },
      { status: 400 },
    );
  }
  if (driver_slot !== 1 && driver_slot !== 2) {
    return NextResponse.json({ error: "driver_slot must be 1 or 2" }, { status: 400 });
  }
  if (conditions !== "dry" && conditions !== "wet") {
    return NextResponse.json({ error: "conditions must be 'dry' or 'wet'" }, { status: 400 });
  }

  const limit = Math.min(Math.max(Number(candidate_limit) || 10, 1), MAX_SETUP_CANDIDATES);

  // Identity comes from the Supabase Auth session cookie server-side — see
  // getAuthedDriver's own doc comment for why this replaced the old
  // client-supplied discord_id + next-auth session pattern, which stopped
  // working entirely once the app's real login flow (src/app/login/page.tsx)
  // moved to Supabase Auth and left next-auth's session permanently empty.
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json(
      { error: "Could not resolve driver identity — no authenticated Supabase session found" },
      { status: 401 },
    );
  }
  const driver_id = driver.id;

  let ranges, session;
  try {
    [ranges, session] = await Promise.all([
      fetchFmParamRanges(),
      fetchOrCreateFmSetupSession({
        driverId: driver_id,
        circuitId: circuit_id,
        conditions,
        driverSlot: driver_slot,
        driverSlotName: driver_slot_name,
      }),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load fm setup engine inputs" },
      { status: 500 },
    );
  }

  if (ranges.length !== FM_SETUP_PARAM_ORDER.length) {
    return NextResponse.json(
      { error: "fm_setup_params is missing rows — expected all 5 setup params to be configured" },
      { status: 422 },
    );
  }

  let currentFeedback = session.current_feedback;
  let currentValues = session.current_values;
  let iterationCount = session.iteration_count;
  const loggedPoints: { bias: FmBiasKey; value: number; feedback: FmFeedbackValue }[] = [];

  // If the driver reported new feedback this call, append it to the
  // session's growing history (never collapse/overwrite past points) and
  // update the tracked current setup.
  if (current_values && new_feedback && Object.keys(new_feedback).length > 0) {
    const bias = setupToBiasKeyed(current_values, ranges);
    currentFeedback = { ...currentFeedback };
    for (const key of FM_BIAS_ORDER) {
      currentFeedback[key] = [...(currentFeedback[key] ?? [])];
    }

    for (const [biasKey, feedbackValue] of Object.entries(new_feedback) as [
      FmBiasKey,
      FmFeedbackValue,
    ][]) {
      const point = { value: bias[biasKey], feedback: feedbackValue };
      currentFeedback[biasKey].push(point);
      loggedPoints.push({ bias: biasKey, ...point });
    }

    currentValues = current_values;
    iterationCount += 1;
  }

  // Anchor the search's tie-breaking distance against: the driver's own
  // current setup if they have one this session, otherwise the best
  // community-converged setup on record for this circuit + conditions (a
  // warm start instead of neutral), falling back to neutral only if neither
  // exists yet.
  let anchorBias: number[];
  if (Object.keys(currentValues).length === FM_SETUP_PARAM_ORDER.length) {
    anchorBias = FM_BIAS_ORDER.map((k) => setupToBiasKeyed(currentValues, ranges)[k]);
  } else {
    let memory;
    try {
      memory = await fetchFmSetupMemory(circuit_id, conditions);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to load fm setup memory" },
        { status: 500 },
      );
    }
    anchorBias = memory
      ? FM_BIASOrder
'this'
      : neutralAnchorBias();
  }

  const result = nearestSetup({ ranges, feedbackByBias: currentFeedback, anchorBias });

  try {
    const updated = await updateFmSetupSession(session.id, {
      current_values: currentValues,
      current_feedback: currentFeedback,
      iteration_count: iterationCount,
    });

    if (loggedPoints.length > 0) {
      // FIX: this used to pass `loggedPoints` (an array of
      // {bias, value, feedback} objects) straight through as `feedback`.
      // The frontend's history panel does
      // `Object.entries(it.feedback ?? {}).map(([bias, fb]) => ...)`,
      // which on an array yields index keys ("0", "1", ...) with `fb` being
      // the *entire* {bias, value, feedback} object — hence
      // `String(fb)` rendering as "[object Object]" in the UI. Reshaping
      // into a bias-keyed object here (e.g. {oversteer: 'good', braking:
      // 'bad'}) matches what the frontend's HistoryIteration type and
      // render code actually expect.
      const feedbackByBias = Object.fromEntries(
        loggedPoints.map((p) => [p.bias, p.feedback]),
      ) as Partial<Record<FmBiasKey, FmFeedbackValue>>;

      await logFmFeedback({
        sessionId: session.id,
        iterationNumber: iterationCount,
        feedback: feedbackByBias,
        appliedDeltas: {
          lowestRuleBreak: result.lowestRuleBreak,
          possibleSetups: result.possibleSetups,
          bestSetup: result.best,
        },
        setupValues: currentValues as Record<FmSetupParamKey, number>,
      });
    }

    // Record this converged setup as the new memory-bank best for this
    // circuit + conditions, if it's at least as good as whatever's already
    // on record. No-op on the very first neutral-anchor pass before any
    // feedback has been given, since result.best is only meaningful once
    // the search has something to converge toward.
    if (result.best) {
      try {
        await upsertFmSetupMemory({
          circuitId: circuit_id,
          conditions,
          setupValues: Object.fromEntries(
            FM_SETUP_PARAM_ORDER.map((key, i) => [key, result.best![i]]),
          ) as Record<FmSetupParamKey, number>,
          lowestRuleBreak: result.lowestRuleBreak,
          possibleSetups: result.possibleSetups,
        });
      } catch (err) {
        // Non-fatal — don't fail the whole calculation if the memory bank
        // write fails, the driver still gets their result this call.
        console.error("[fm/setups/calculate] fm setup memory upsert failed", err);
      }
    }

    return NextResponse.json(
      {
        session_id: session.id,
        iteration_count: updated.iteration_count,
        lowest_rule_break: result.lowestRuleBreak,
        possible_setups: result.possibleSetups,
        best_setup: result.best
          ? Object.fromEntries(FM_SETUP_PARAM_ORDER.map((key, i) => [key, result.best![i]]))
          : null,
        candidates: result.candidates.slice(0, limit).map((c) => ({
          setup: Object.fromEntries(FM_SETUP_PARAM_ORDER.map((key, i) => [key, c.setup[i]])),
          diff: c.diff,
        })),
        current_feedback: currentFeedback,
        // The absolute setup the driver was actually running in-game when
        // they reported this iteration's feedback — not the resulting
        // `result.best` candidate, which is the *next* recommendation.
        setup_values: currentValues as Record<FmSetupParamKey, number>,
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to persist fm setup session" },
      { status: 500 },
    );
  }
}
