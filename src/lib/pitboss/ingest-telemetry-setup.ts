// ingest-telemetry-setup.ts — Converts a parsed F1 25/26 CarSetups packet
// into a pitboss.setup_submissions row with source: 'telemetry'.
//
// Key mapping matches the live param_key/param_group convention in
// pitboss.setup_parameter_ranges (verified against the DB directly —
// see migration `add_engine_braking_and_ballast_param_ranges` for the
// two keys, engine_braking and ballast, that didn't exist until now).
//
// NOT included: nextFrontWingValue — that's a "value after next pit
// stop" field, not a current setup parameter, so it has no param_key
// and isn't written here.

import { supabaseAdmin } from '@/lib/supabase/admin';
import type { CarSetupData25 } from '@/lib/pitboss/telemetry-capture/f25';
import type { CarSetupData26 } from '@/lib/pitboss/telemetry-capture/f26';

type CarSetupData = CarSetupData25 | CarSetupData26;

/**
 * Maps CarSetupData field names to their setup_parameter_ranges param_key.
 * One flat object since the struct is byte-for-byte identical between F25
 * and F26 (only NUM_CARS differs, which doesn't affect this mapping).
 */
const PARAM_KEY_MAP: Record<keyof CarSetupData, string> = {
  frontWing: 'front_wing_aero',
  rearWing: 'rear_wing_aero',
  onThrottle: 'diff_adjustment_on_throttle',
  offThrottle: 'diff_adjustment_off_throttle',
  frontCamber: 'front_camber',
  rearCamber: 'rear_camber',
  frontToe: 'front_toe_out',
  rearToe: 'rear_toe_in',
  frontSuspension: 'front_suspension',
  rearSuspension: 'rear_suspension',
  frontAntiRollBar: 'front_arb',
  rearAntiRollBar: 'rear_arb',
  frontSuspensionHeight: 'front_ride_height',
  rearSuspensionHeight: 'rear_ride_height',
  brakePressure: 'brake_pressure',
  brakeBias: 'front_brake_bias',
  engineBraking: 'engine_braking',
  rearLeftTyrePressure: 'rear_left_tyre_pressure',
  rearRightTyrePressure: 'rear_right_tyre_pressure',
  frontLeftTyrePressure: 'front_left_tyre_pressure',
  frontRightTyrePressure: 'front_right_tyre_pressure',
  ballast: 'ballast',
  fuelLoad: 'fuel_load',
};

export interface IngestSetupContext {
  /** Resolved from the game/season the telemetry session was captured under. */
  carClassId: string;
  trackId: string;
  leagueId?: string | null;
  conditions?: 'dry' | 'wet' | 'mixed';
  sessionType?: 'race' | 'qualifying' | 'sprint' | 'time_trial' | 'practice';
  /** Driver who owns this telemetry capture, if known. */
  submittedBy?: string | null;
  notes?: string | null;
  /** Only the player's own car's setup should ever be ingested — pass the array index explicitly. */
  playerCarIndex: number;
}

/**
 * Builds the setup_values JSONB payload from a single car's setup data.
 * Exported separately so callers can inspect/validate before writing.
 */
export function buildSetupValues(setup: CarSetupData): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [field, paramKey] of Object.entries(PARAM_KEY_MAP) as [keyof CarSetupData, string][]) {
    values[paramKey] = setup[field] as number;
  }
  return values;
}

/**
 * Inserts a telemetry-sourced setup submission. Confidence is fixed at a
 * conservative default since this is a raw capture, not a
 * driver-reviewed/verified setup — adjust the caller if you want to
 * differentiate qualifying-lap captures from practice-lap noise.
 */
export async function ingestTelemetrySetup(
  carSetups: CarSetupData[],
  ctx: IngestSetupContext,
) {
  const setup = carSetups[ctx.playerCarIndex];
  if (!setup) {
    throw new Error(`No car setup data at index ${ctx.playerCarIndex}`);
  }

  const setup_values = buildSetupValues(setup);

  const { data, error } = await supabaseAdmin
    .schema('pitboss')
    .from('setup_submissions')
    .insert({
      league_id: ctx.leagueId ?? null,
      car_class_id: ctx.carClassId,
      track_id: ctx.trackId,
      conditions: ctx.conditions ?? 'dry',
      session_type: ctx.sessionType ?? 'race',
      setup_values,
      source: 'telemetry',
      source_name: null,
      source_url: null,
      confidence: 0.6,
      verified: false,
      submitted_by: ctx.submittedBy ?? null,
      notes: ctx.notes ?? null,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}
