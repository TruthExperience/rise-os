import { createAdminClient } from "@/lib/supabase/admin"; // adjust to your actual admin client export

// Corner order used consistently everywhere per-corner data appears.
// F1 25 UDP telemetry packets use this order for all 4-length arrays
// (tyresSurfaceTemperature, tyresInnerTemperature, tyresPressure, tyresWear, brakesTemperature).
export const CORNERS = ["FL", "FR", "RL", "RR"] as const;
export type Corner = (typeof CORNERS)[number];

export interface TelemetryFrame {
  dist: number;
  speed: number;
  throttle: number; // 0-1
  brake: number; // 0-1
  gear: number;
  steer: number; // degrees
  drs: boolean;
  x: number;
  y: number;
  tyreTemp: Record<Corner, number>; // surface temp, °C
  tyreTempInner: Record<Corner, number>;
  brakeTemp: Record<Corner, number>; // °C
  tyrePressure: Record<Corner, number>;
  tyreWear: Record<Corner, number>;
  rpm: number;
  gLat: number;
  gLon: number;
  fuel: number;
  ers: number;
  engineTemp: number;
}

export interface TelemetryLap {
  lapNum: number;
  lapTime: number;
  sector1: number;
  sector2: number;
  sector3: number;
  lapValid: boolean;
  tyres: string;
  track: string;
  trackTemp: number;
  airTemp: number;
  carSetup: Record<string, unknown>;
  frames: TelemetryFrame[];
}

export interface TelemetrySession {
  sessionUid: string; // kept as text throughout — never round-tripped through a JS number
  driverId: string;
  laps: TelemetryLap[];
}

function toCornerRecord(arr: number[] | null | undefined): Record<Corner, number> {
  const [fl, fr, rl, rr] = arr ?? [0, 0, 0, 0];
  return { FL: fl, FR: fr, RL: rl, RR: rr };
}

function reshapeFrame(f: any): TelemetryFrame {
  return {
    dist: f.lapDistanceInMeters,
    speed: f.speed,
    throttle: f.throttle,
    brake: f.brake,
    gear: f.gear,
    steer: f.steerInDegrees,
    drs: !!f.drsEnabled,
    x: f.worldPositionX,
    y: f.worldPositionY,
    tyreTemp: toCornerRecord(f.tyresSurfaceTemperature),
    tyreTempInner: toCornerRecord(f.tyresInnerTemperature),
    brakeTemp: toCornerRecord(f.brakesTemperature),
    tyrePressure: toCornerRecord(f.tyresPressure),
    tyreWear: toCornerRecord(f.tyresWear),
    rpm: f.engineRPM,
    gLat: f.gForceLateral,
    gLon: f.gForceLongitudinal,
    fuel: f.fuelInTank,
    ers: f.ersDeployedInLap,
    engineTemp: f.engineTemperature,
  };
}

/**
 * Fetch every lap for a given session UID from pitboss.setup_telemetry_uploads
 * and reshape into TelemetrySession. session_uid is stored as text — pass it
 * as a string, never as a number (F1 session UIDs overflow JS number precision).
 */
export async function getTelemetrySession(sessionUid: string): Promise<TelemetrySession | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema("pitboss")
    .from("setup_telemetry_uploads")
    .select("driver_id, lap_num, lap_time_seconds, sector1_time_seconds, sector2_time_seconds, sector3_time_seconds, lap_valid, tyre_compound, track_temperature, air_temperature, raw_payload")
    .eq("session_uid", sessionUid)
    .order("lap_num", { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const laps: TelemetryLap[] = data.map((row) => {
    const payload = row.raw_payload as any;
    const frames: TelemetryFrame[] = (payload?.telemetry ?? []).map(reshapeFrame);

    return {
      lapNum: row.lap_num,
      lapTime: Number(row.lap_time_seconds),
      sector1: Number(row.sector1_time_seconds),
      sector2: Number(row.sector2_time_seconds),
      sector3: Number(row.sector3_time_seconds),
      lapValid: row.lap_valid,
      tyres: row.tyre_compound,
      track: payload?.track,
      trackTemp: Number(row.track_temperature),
      airTemp: Number(row.air_temperature),
      carSetup: payload?.carSetup ?? {},
      frames,
    };
  });

  return {
    sessionUid,
    driverId: data[0].driver_id,
    laps,
  };
}

/** Average of the 4 corners — used as the default trace before a corner is picked. */
export function cornerAvg(rec: Record<Corner, number>): number {
  return (rec.FL + rec.FR + rec.RL + rec.RR) / 4;
}
