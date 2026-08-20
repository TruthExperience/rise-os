import { createAdminClient } from "@/lib/supabase/server";
import {
  type Corner,
  type TelemetryFrame,
  type TelemetryLap,
  type TelemetrySession,
} from "@/lib/telemetry-types";

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
      // raw_payload.track is an object ({id, name, lengthInMeters, ...}),
      // not a string — pull the name out here so consumers get a plain string.
      track: payload?.track?.name ?? "unknown",
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

export interface TelemetrySessionSummary {
  sessionUid: string;
  driverId: string | null;
  trackName: string | null;
  lapCount: number;
  uploadedAt: string;
}

/** League IDs where this driver is a steward or head steward. */
export async function getStewardLeagueIds(driverId: string): Promise<string[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("league_id")
    .eq("driver_id", driverId)
    .or("is_steward.eq.true,is_head_steward.eq.true");

  if (error) throw error;
  return (data ?? []).map((row) => row.league_id as string);
}

/**
 * Sessions visible to this driver: their own uploads, plus any session
 * belonging to a league where they're a steward.
 */
export async function listTelemetrySessionsForDriver(
  driverId: string,
  stewardLeagueIds: string[]
): Promise<TelemetrySessionSummary[]> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .schema("pitboss")
    .from("setup_telemetry_uploads")
    .select("session_uid, driver_id, created_at, raw_payload, submission_id, setup_submissions(league_id)")
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!data) return [];

  const bySession = new Map<
    string,
    { driverId: string | null; track: string | null; uploadedAt: string; leagueId: string | null; lapCount: number }
  >();

  for (const row of data as any[]) {
    const key = row.session_uid;
    const leagueId = row.setup_submissions?.league_id ?? null;
    const existing = bySession.get(key);
    if (existing) {
      existing.lapCount += 1;
    } else {
      bySession.set(key, {
        driverId: row.driver_id,
        // raw_payload.track is an object ({id, name, lengthInMeters, ...}),
        // not a string — pull the name out here so consumers get a plain string.
        track: row.raw_payload?.track?.name ?? null,
        uploadedAt: row.created_at,
        leagueId,
        lapCount: 1,
      });
    }
  }

  const results: TelemetrySessionSummary[] = [];
  for (const [sessionUid, s] of bySession) {
    const isOwn = s.driverId === driverId;
    const isStewardVisible = s.leagueId != null && stewardLeagueIds.includes(s.leagueId);
    if (isOwn || isStewardVisible) {
      results.push({
        sessionUid,
        driverId: s.driverId,
        trackName: s.track,
        lapCount: s.lapCount,
        uploadedAt: s.uploadedAt,
      });
    }
  }

  results.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  return results;
}
