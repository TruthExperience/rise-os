import { NextRequest, NextResponse } from "next/server";
import {
  nearestSetup,
  setupToBiasKeyed,
  neutralAnchorBias,
  startingSetupForLean,
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
  fetchFmCircuitLean,
  seedFmSetupMemory,
  upsertFmSetupMemory,
  resetFmSetupSessionFeedback,
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
  // When set to "reset", clears this session's feedback history and
  // iteration count (current_values is left untouched) instead of running
  // a calculation. All other optional fields above are ignored when this
  // is set. Requires circuit_id, conditions, and driver_slot to resolve
  // which session to clear, same as a normal calculate call.
  action?: "reset";
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
    action,
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

  // Reset short-circuits everything below: no feedback processing, no
  // solver run, no memory-bank write. Just clears this session's feedback
  // history and iteration count and hands back the cleared state so the
  // frontend can update its history panel / iteration badge immediately.
  // current_values (the driver's slider position) is deliberately left
  // untouched — see resetFmSetupSessionFeedback's doc comment.
  if (action === "reset") {
    try {
      const cleared = await resetFmSetupSessionFeedback(session.id);
      return NextResponse.json(
        {
          session_id: cleared.id,
          iteration_count: cleared.iteration_count,
          current_feedback: cleared.current_feedback,
          current_values: cleared.current_values,
        },
        { status: 200 },
      );
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to reset fm setup feedback" },
        { status: 500 },
      );
    }
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
  // community-converged setup on record for this circuit + conditions, and
  // failing that the circuit's downforce-lean starting preset (seeded into
  // the memory bank so it is shared and visible). neutralAnchorBias() is now
  // only the last resort for a circuit whose lean lookup failed — it is the
  // same at every track, which is exactly what the lean preset replaces.
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

    if (memory) {
      anchorBias = FM_BIAS_ORDER.map((k) => setupToBiasKeyed(memory.setup_values, ranges)[k]);
    } else {
      // A brand-new circuit: derive its starting preset from downforce_lean
      // (fm_circuits) rather than anchoring every track to the same neutral
      // values, then seed that preset into the memory bank for later drivers.
      let seed: Record<FmSetupParamKey, number> | null = null;
      try {
        const lean = await fetchFmCircuitLean(circuit_id);
        seed = startingSetupForLean(ranges, lean);
      } catch (err) {
        console.error("[fm/setups/calculate] fm circuit lean lookup failed", err);
      }

      if (seed) {
        anchorBias = FM_BIAS_ORDER.map((k) => setupToBiasKeyed(seed!, ranges)[k]);
        try {
          await seedFmSetupMemory({ circuitId: circuit_id, conditions, setupValues: seed });
        } catch (err) {
          // Non-fatal — the driver still gets their result this call.
          console.error("[fm/setups/calculate] fm setup memory seed failed", err);
        }
      } else {
        anchorBias = neutralAnchorBias();
      }
    }
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
      });
    }

    // Record this converged setup as the new memory-bank best for this
    // circuit + conditions. Only when feedback was actually given this call:
    // with an empty feedback history every candidate ties at 0 rule-breaks and
    // result.best is just whichever setup sits closest to the anchor, so
    // writing it would (a) stamp the anchor back into memory and (b) at 0
    // rule-breaks make the row permanently un-replaceable, since
    // upsertFmSetupMemory only overwrites strictly better entries.
    if (result.best && loggedPoints.length > 0) {
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
