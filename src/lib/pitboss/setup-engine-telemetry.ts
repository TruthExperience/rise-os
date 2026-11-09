// File: src/lib/pitboss/setup-engine-telemetry.ts
//
// NEW FILE. Telemetry fetchers for the setup engine.
//
// Two jobs:
//  1. fetchTelemetryPerformanceSamples — telemetry-sourced setup_submissions
//     paired with the lap time they produced, shaped for the existing (but
//     previously never called) applyTelemetryPerformanceBias in setup-engine.ts.
//  2. fetchTelemetryContext — the compact summary from the
//     pitboss.get_telemetry_context() SQL function (lap/sector times, tyre
//     temps + wear, setups tried), handed to the LLM so it can ground
//     adjustments in measured data instead of guessing.

import { createAdminClient } from '@/lib/supabase/server';
import type { TelemetryPerformanceSample } from './setup-engine';

export interface TelemetryContext {
  available: boolean;
  scope: 'driver' | 'pool' | 'none';
  upload_ids: string[];
  laps_used?: number;
  best_lap_s?: number;
  avg_lap_s?: number;
  best_sectors_s?: { s1: number | null; s2: number | null; s3: number | null };
  tyre_compounds?: string[];
  conditions?: { avg_track_temp_c: number | null; avg_air_temp_c: number | null };
  // Arrays are [RL, RR, FL, FR] — read straight from the F1 UDP packet.
  tyre_order_note?: string;
  avg_tyre_surface_temp_c?: number[];
  avg_tyre_inner_temp_c?: number[];
  avg_tyre_wear_delta_pct?: number[];
  distinct_setups_tried?: number;
  setups_by_best_lap?: { best_lap_s: number; laps: number; setup: Record<string, number> }[];
}

const EMPTY_CONTEXT: TelemetryContext = { available: false, scope: 'none', upload_ids: [] };

/**
 * Telemetry-sourced submissions + their lap times, for rank-weighted
 * performance bias. Valid laps only. Scoped to the same
 * track / car class / conditions / session type bucket as fetchSubmissions.
 */
export async function fetchTelemetryPerformanceSamples(params: {
  trackId: string;
  carClassId: string;
  conditions: string;
  sessionType: string;
}): Promise<TelemetryPerformanceSample[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema('pitboss')
    .from('setup_telemetry_uploads')
    .select(
      'lap_time_seconds, lap_valid, submission:setup_submissions!setup_telemetry_uploads_submission_id_fkey(id, league_id, setup_values, confidence, verified, source_name, source_url, conditions, session_type)'
    )
    .eq('track_id', params.trackId)
    .eq('car_class_id', params.carClassId)
    .eq('lap_valid', true)
    .not('lap_time_seconds', 'is', null)
    .not('submission_id', 'is', null);

  if (error) {
    // Telemetry is an enhancement layer — never fail a recommendation over it.
    console.error('fetchTelemetryPerformanceSamples failed:', error.message);
    return [];
  }

  const samples: TelemetryPerformanceSample[] = [];
  for (const row of data ?? []) {
    const sub: any = Array.isArray(row.submission) ? row.submission[0] : row.submission;
    if (!sub) continue;
    if (sub.conditions !== params.conditions || sub.session_type !== params.sessionType) continue;
    samples.push({
      id: sub.id,
      league_id: sub.league_id,
      setup_values: sub.setup_values as Record<string, number>,
      confidence: Number(sub.confidence),
      verified: Boolean(sub.verified),
      source_name: sub.source_name,
      source_url: sub.source_url,
      lap_time_seconds: Number(row.lap_time_seconds),
    });
  }
  return samples;
}

/**
 * Summary of recent telemetry for this driver/track/car class (falls back to
 * other drivers on the same track/car class when this driver has none).
 * Never throws — returns { available: false } on any problem.
 */
export async function fetchTelemetryContext(params: {
  driverId: string | null;
  trackId: string;
  carClassId: string;
  sessionType: string | null;
  limit?: number;
}): Promise<TelemetryContext> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.schema('pitboss').rpc('get_telemetry_context', {
    p_driver_id: params.driverId,
    p_track_id: params.trackId,
    p_car_class_id: params.carClassId,
    p_session_type: params.sessionType,
    p_limit: params.limit ?? 8,
  });

  if (error || !data) {
    if (error) console.error('fetchTelemetryContext failed:', error.message);
    return EMPTY_CONTEXT;
  }
  return data as TelemetryContext;
}
