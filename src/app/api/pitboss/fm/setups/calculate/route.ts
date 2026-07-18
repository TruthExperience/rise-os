import { NextRequest, NextResponse } from "next/server";
import {
  nearestSetup,
  setupToBiasKeyed,
  neutralAnchorBias,
  FM_BIAS_ORDER,
  FM_SETUP_PARAM_ORDER,
  FmSetupParamKey,
  FmBiasKey,
  FmFeedbackValue,
} from "@/lib/pitboss/fm-setup-engine";
import {
  fetchFmParamRanges,
  fetchOrCreateFmSetupSession,
  updateFmSetupSession,
  logFmFeedback,
} from "@/lib/pitboss/fm-setup-engine-data";
import { resolveDriverIdFromSession } from "@/lib/pitboss/resolveDriver";

interface CalculateRequestBody {
  circuit_id: string;
  conditions: "dry" | "wet";
  driver_slot: 1 | 2;
  driver_slot_name?: string | null;
  // Discord snowflake, resolved server-side — same pattern as
  // /api/pitboss/setups/recommend. Never trust a client-supplied driver_id
  // for identity.
  discord_id?: string | null;
  driver_id?: string | null;
  // The setup the driver just tried in-game, if this call is reporting new
  // feedback on it. Omit to just re-run the search against existing
  // feedback (e.g. re-fetching candidates after a session was already
  // populated elsewhere).
  current_values?: Record<FmSetupParamKey, number>;
  // One feedback point per bias category being reported this call. Only
  // include the categories the driver actually gave feedback on.
  new_feedback?: Partial<Record<FmBiasKey, FmFeedbackValue>>;
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
    discord_id = null,
    driver_id: driverIdOverride = null,
    current_values,
    new_feedback,
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

  const anchorBias =
    Object.keys(currentValues).length === FM_SETUP_PARAM_ORDER.length
      ? FM_BIAS_ORDER.map((k) => setupToBiasKeyed(currentValues, ranges)[k])
      : neutralAnchorBias();

  const result = nearestSetup({ ranges, feedbackByBias: currentFeedback, anchorBias });

  try {
    const updated = await updateFmSetupSession(session.id, {
      current_values: currentValues,
      current_feedback: currentFeedback,
      iteration_count: iterationCount,
    });

    if (loggedPoints.length > 0) {
      await logFmFeedback({
        sessionId: session.id,
        iterationNumber: iterationCount,
        feedback: loggedPoints,
        appliedDeltas: {
          lowestRuleBreak: result.lowestRuleBreak,
          possibleSetups: result.possibleSetups,
          bestSetup: result.best,
        },
      });
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
        candidates: result.candidates.slice(0, 10).map((c) => ({
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
