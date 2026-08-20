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
  driverId: string | null; // setup_telemetry_uploads.driver_id is nullable in the DB
  laps: TelemetryLap[];
}

/** Average of the 4 corners — used as the default trace before a corner is picked. */
export function cornerAvg(rec: Record<Corner, number>): number {
  return (rec.FL + rec.FR + rec.RL + rec.RR) / 4;
}
