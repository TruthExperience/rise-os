// f26.ts — F1 26 packet body parsers (Motion, Session, LapData,
// Participants, CarTelemetry, CarStatus, CarDamage). Field layouts and
// byte offsets verified against EA's official "2026 Season Pack
// Telemetry Output Structures" spec, published alongside the base F1 25
// spec for direct comparison:
//   https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-udp-specification/12187347
//
// IMPORTANT: "F1 26" here means the F1® 25: 2026 Season Pack UDP format
// — a menu toggle inside F1 25 itself, not a separate game (confirmed by
// EA_Groguet's post on the above thread and by header.ts's own note).
// packetFormat 2026 selects this parser module.
//
// Every struct below was cross-checked by summing its field sizes and
// confirming the result matches EA's documented total packet size,
// exactly the same rigor as f25.ts (each total below matched EA's
// stated size on the first attempt except CarTelemetry, which is why
// its engineTemperature width change was caught).
//
// Confirmed changes vs F25 (every other field, in every other struct,
// is byte-for-byte identical to f25.ts):
//   - cs_maxNumCarsInUDPData: 22 -> 24. Affects every packet's array
//     length and total size, not just packets with per-struct changes.
//   - Motion: m_gForceLateral/Longitudinal/Vertical changed from
//     float32 to int16 ("quantised" per EA's comment — divide by
//     1000.0 to get the actual value). NOT converted here; callers
//     needing the real value must divide gForce* by 1000.
//   - Session: new "Active Aero and DRS zones" block appended after
//     m_sector3LapDistanceStart (+173 bytes) — activeAeroTrackStatus,
//     two ActiveAeroZone arrays (full/partial, max 8 each), a DRSZone
//     array (max 4), startReactionTime, and five more assist/UX flags.
//     Also: m_formula gained value 13 = "F1 26" (vs 0 = F1 Modern) as
//     a genuine in-spec signal for 2026-regs cars, for anything that
//     wants to distinguish car generation from live packet data rather
//     than from a lap-export JSON (which doesn't carry this field).
//   - Participants: driverId, networkId, teamId widened from uint8 to
//     uint16 each (+3 bytes/car).
//   - CarTelemetry: engineTemperature narrowed from uint16 to uint8
//     (-1 byte/car).
//   - CarStatus: new field ersHarvestLimitPerLap (float32) inserted
//     between ersHarvestedThisLapMGUH and ersDeployedThisLap
//     (+4 bytes/car).
//   - LapData, CarDamage: structs unchanged (only benefit from the
//     NUM_CARS 22->24 change).

import { HEADER_SIZE_BYTES, parseHeader, PacketHeader } from './header';

class Reader {
  private offset: number;
  constructor(private buf: Buffer, offset = 0) {
    this.offset = offset;
  }
  get pos(): number {
    return this.offset;
  }
  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  i8(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  i16(): number {
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  f32(): number {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }
  /** Fixed-length, null-terminated UTF-8 string (used for driver names). */
  cstr(len: number): string {
    const slice = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    const nullIdx = slice.indexOf(0);
    return (nullIdx === -1 ? slice : slice.subarray(0, nullIdx)).toString('utf-8');
  }
}

const NUM_CARS = 24; // cs_maxNumCarsInUDPData, up from 22 in F25

function readWheelArrayU16(r: Reader): [number, number, number, number] {
  return [r.u16(), r.u16(), r.u16(), r.u16()];
}
function readWheelArrayU8(r: Reader): [number, number, number, number] {
  return [r.u8(), r.u8(), r.u8(), r.u8()];
}
function readWheelArrayF32(r: Reader): [number, number, number, number] {
  return [r.f32(), r.f32(), r.f32(), r.f32()];
}

// ---------------------------------------------------------------------
// Motion — 1325 bytes total = 29 (header) + 24 * 54.
// gForce fields changed float32 -> int16 (quantised) vs F25.
// ---------------------------------------------------------------------

export interface CarMotionData26 {
  worldPositionX: number;
  worldPositionY: number;
  worldPositionZ: number;
  worldVelocityX: number;
  worldVelocityY: number;
  worldVelocityZ: number;
  worldForwardDirX: number;
  worldForwardDirY: number;
  worldForwardDirZ: number;
  worldRightDirX: number;
  worldRightDirY: number;
  worldRightDirZ: number;
  /** Quantised — divide by 1000.0 for the actual g-force value. */
  gForceLateral: number;
  /** Quantised — divide by 1000.0 for the actual g-force value. */
  gForceLongitudinal: number;
  /** Quantised — divide by 1000.0 for the actual g-force value. */
  gForceVertical: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface PacketMotionData26 {
  header: PacketHeader;
  carMotionData: CarMotionData26[];
}

function readCarMotionData26(r: Reader): CarMotionData26 {
  return {
    worldPositionX: r.f32(),
    worldPositionY: r.f32(),
    worldPositionZ: r.f32(),
    worldVelocityX: r.f32(),
    worldVelocityY: r.f32(),
    worldVelocityZ: r.f32(),
    worldForwardDirX: r.i16(),
    worldForwardDirY: r.i16(),
    worldForwardDirZ: r.i16(),
    worldRightDirX: r.i16(),
    worldRightDirY: r.i16(),
    worldRightDirZ: r.i16(),
    gForceLateral: r.i16(),
    gForceLongitudinal: r.i16(),
    gForceVertical: r.i16(),
    yaw: r.f32(),
    pitch: r.f32(),
    roll: r.f32(),
  };
}

export function parseMotion26(buf: Buffer): PacketMotionData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carMotionData: CarMotionData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) carMotionData.push(readCarMotionData26(r));
  return { header, carMotionData };
}

// ---------------------------------------------------------------------
// Session — 926 bytes total = 29 (header) + 724 (F25-identical prefix,
// through sector3LapDistanceStart) + 173 (new Active Aero/DRS zones
// block).
// ---------------------------------------------------------------------

export interface MarshalZone26 {
  zoneStart: number;
  zoneFlag: number;
}

export interface WeatherForecastSample26 {
  sessionType: number;
  timeOffset: number;
  weather: number;
  trackTemperature: number;
  trackTemperatureChange: number;
  airTemperature: number;
  airTemperatureChange: number;
  rainPercentage: number;
}

/** New in F26 — see EA's ActiveAeroZone / DRSZone structs. */
export interface AeroZone26 {
  zoneStart: number;
  zoneEnd: number;
}

export interface PacketSessionData26 {
  header: PacketHeader;
  weather: number;
  trackTemperature: number;
  airTemperature: number;
  totalLaps: number;
  trackLength: number;
  sessionType: number;
  trackId: number;
  /** 0 F1 Modern, 1 F1 Classic, 2 F2, 3 F1 Generic, 4 Beta, 6 Esports, 8 F1 World, 9 F1 Elimination, 13 F1 26 (new value in F26). */
  formula: number;
  sessionTimeLeft: number;
  sessionDuration: number;
  pitSpeedLimit: number;
  gamePaused: number;
  isSpectating: number;
  spectatorCarIndex: number;
  sliProNativeSupport: number;
  numMarshalZones: number;
  marshalZones: MarshalZone26[];
  safetyCarStatus: number;
  networkGame: number;
  numWeatherForecastSamples: number;
  weatherForecastSamples: WeatherForecastSample26[];
  forecastAccuracy: number;
  aiDifficulty: number;
  seasonLinkIdentifier: number;
  weekendLinkIdentifier: number;
  sessionLinkIdentifier: number;
  pitStopWindowIdealLap: number;
  pitStopWindowLatestLap: number;
  pitStopRejoinPosition: number;
  steeringAssist: number;
  brakingAssist: number;
  gearboxAssist: number;
  pitAssist: number;
  pitReleaseAssist: number;
  ersAssist: number;
  drsAssist: number;
  dynamicRacingLine: number;
  dynamicRacingLineType: number;
  gameMode: number;
  ruleSet: number;
  timeOfDay: number;
  sessionLength: number;
  speedUnitsLeadPlayer: number;
  temperatureUnitsLeadPlayer: number;
  speedUnitsSecondaryPlayer: number;
  temperatureUnitsSecondaryPlayer: number;
  numSafetyCarPeriods: number;
  numVirtualSafetyCarPeriods: number;
  numRedFlagPeriods: number;
  equalCarPerformance: number;
  recoveryMode: number;
  flashbackLimit: number;
  surfaceType: number;
  lowFuelMode: number;
  raceStarts: number;
  tyreTemperature: number;
  pitLaneTyreSim: number;
  carDamage: number;
  carDamageRate: number;
  collisions: number;
  collisionsOffForFirstLapOnly: number;
  mpUnsafePitRelease: number;
  mpOffForGriefing: number;
  cornerCuttingStringency: number;
  parcFermeRules: number;
  pitStopExperience: number;
  safetyCar: number;
  safetyCarExperience: number;
  formationLap: number;
  formationLapExperience: number;
  redFlags: number;
  affectsLicenceLevelSolo: number;
  affectsLicenceLevelMP: number;
  numSessionsInWeekend: number;
  weekendStructure: number[];
  sector2LapDistanceStart: number;
  sector3LapDistanceStart: number;
  // --- New in F26 below this line ---
  activeAeroTrackStatus: number;
  numActiveAeroZonesFull: number;
  activeAeroZonesFull: AeroZone26[];
  numActiveAeroZonesPartial: number;
  activeAeroZonesPartial: AeroZone26[];
  numDRSZones: number;
  drsZones: AeroZone26[];
  startReactionTime: number;
  antiLockBrakesAssist: number;
  tractionControlAssist: number;
  dynamicRacingLineHiVis: number;
  dynamicRacingLineColourBlind: number;
  recurringRewindPrompt: number;
}

function readMarshalZone26(r: Reader): MarshalZone26 {
  return { zoneStart: r.f32(), zoneFlag: r.i8() };
}

function readWeatherForecastSample26(r: Reader): WeatherForecastSample26 {
  return {
    sessionType: r.u8(),
    timeOffset: r.u8(),
    weather: r.u8(),
    trackTemperature: r.i8(),
    trackTemperatureChange: r.i8(),
    airTemperature: r.i8(),
    airTemperatureChange: r.i8(),
    rainPercentage: r.u8(),
  };
}

function readAeroZone26(r: Reader): AeroZone26 {
  return { zoneStart: r.f32(), zoneEnd: r.f32() };
}

export function parseSession26(buf: Buffer): PacketSessionData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);

  const weather = r.u8();
  const trackTemperature = r.i8();
  const airTemperature = r.i8();
  const totalLaps = r.u8();
  const trackLength = r.u16();
  const sessionType = r.u8();
  const trackId = r.i8();
  const formula = r.u8();
  const sessionTimeLeft = r.u16();
  const sessionDuration = r.u16();
  const pitSpeedLimit = r.u8();
  const gamePaused = r.u8();
  const isSpectating = r.u8();
  const spectatorCarIndex = r.u8();
  const sliProNativeSupport = r.u8();
  const numMarshalZones = r.u8();

  const marshalZones: MarshalZone26[] = [];
  for (let i = 0; i < 21; i++) marshalZones.push(readMarshalZone26(r));

  const safetyCarStatus = r.u8();
  const networkGame = r.u8();
  const numWeatherForecastSamples = r.u8();

  const weatherForecastSamples: WeatherForecastSample26[] = [];
  for (let i = 0; i < 64; i++) weatherForecastSamples.push(readWeatherForecastSample26(r));

  const forecastAccuracy = r.u8();
  const aiDifficulty = r.u8();
  const seasonLinkIdentifier = r.u32();
  const weekendLinkIdentifier = r.u32();
  const sessionLinkIdentifier = r.u32();
  const pitStopWindowIdealLap = r.u8();
  const pitStopWindowLatestLap = r.u8();
  const pitStopRejoinPosition = r.u8();
  const steeringAssist = r.u8();
  const brakingAssist = r.u8();
  const gearboxAssist = r.u8();
  const pitAssist = r.u8();
  const pitReleaseAssist = r.u8();
  const ersAssist = r.u8();
  const drsAssist = r.u8();
  const dynamicRacingLine = r.u8();
  const dynamicRacingLineType = r.u8();
  const gameMode = r.u8();
  const ruleSet = r.u8();
  const timeOfDay = r.u32();
  const sessionLength = r.u8();
  const speedUnitsLeadPlayer = r.u8();
  const temperatureUnitsLeadPlayer = r.u8();
  const speedUnitsSecondaryPlayer = r.u8();
  const temperatureUnitsSecondaryPlayer = r.u8();
  const numSafetyCarPeriods = r.u8();
  const numVirtualSafetyCarPeriods = r.u8();
  const numRedFlagPeriods = r.u8();
  const equalCarPerformance = r.u8();
  const recoveryMode = r.u8();
  const flashbackLimit = r.u8();
  const surfaceType = r.u8();
  const lowFuelMode = r.u8();
  const raceStarts = r.u8();
  const tyreTemperature = r.u8();
  const pitLaneTyreSim = r.u8();
  const carDamage = r.u8();
  const carDamageRate = r.u8();
  const collisions = r.u8();
  const collisionsOffForFirstLapOnly = r.u8();
  const mpUnsafePitRelease = r.u8();
  const mpOffForGriefing = r.u8();
  const cornerCuttingStringency = r.u8();
  const parcFermeRules = r.u8();
  const pitStopExperience = r.u8();
  const safetyCar = r.u8();
  const safetyCarExperience = r.u8();
  const formationLap = r.u8();
  const formationLapExperience = r.u8();
  const redFlags = r.u8();
  const affectsLicenceLevelSolo = r.u8();
  const affectsLicenceLevelMP = r.u8();
  const numSessionsInWeekend = r.u8();

  const weekendStructure: number[] = [];
  for (let i = 0; i < 12; i++) weekendStructure.push(r.u8());

  const sector2LapDistanceStart = r.f32();
  const sector3LapDistanceStart = r.f32();

  // --- New in F26 ---
  const activeAeroTrackStatus = r.u8();
  const numActiveAeroZonesFull = r.u8();
  const activeAeroZonesFull: AeroZone26[] = [];
  for (let i = 0; i < 8; i++) activeAeroZonesFull.push(readAeroZone26(r));
  const numActiveAeroZonesPartial = r.u8();
  const activeAeroZonesPartial: AeroZone26[] = [];
  for (let i = 0; i < 8; i++) activeAeroZonesPartial.push(readAeroZone26(r));
  const numDRSZones = r.u8();
  const drsZones: AeroZone26[] = [];
  for (let i = 0; i < 4; i++) drsZones.push(readAeroZone26(r));
  const startReactionTime = r.f32();
  const antiLockBrakesAssist = r.u8();
  const tractionControlAssist = r.u8();
  const dynamicRacingLineHiVis = r.u8();
  const dynamicRacingLineColourBlind = r.u8();
  const recurringRewindPrompt = r.u8();

  return {
    header, weather, trackTemperature, airTemperature, totalLaps, trackLength,
    sessionType, trackId, formula, sessionTimeLeft, sessionDuration, pitSpeedLimit,
    gamePaused, isSpectating, spectatorCarIndex, sliProNativeSupport, numMarshalZones,
    marshalZones, safetyCarStatus, networkGame, numWeatherForecastSamples,
    weatherForecastSamples, forecastAccuracy, aiDifficulty, seasonLinkIdentifier,
    weekendLinkIdentifier, sessionLinkIdentifier, pitStopWindowIdealLap,
    pitStopWindowLatestLap, pitStopRejoinPosition, steeringAssist, brakingAssist,
    gearboxAssist, pitAssist, pitReleaseAssist, ersAssist, drsAssist,
    dynamicRacingLine, dynamicRacingLineType, gameMode, ruleSet, timeOfDay,
    sessionLength, speedUnitsLeadPlayer, temperatureUnitsLeadPlayer,
    speedUnitsSecondaryPlayer, temperatureUnitsSecondaryPlayer, numSafetyCarPeriods,
    numVirtualSafetyCarPeriods, numRedFlagPeriods, equalCarPerformance, recoveryMode,
    flashbackLimit, surfaceType, lowFuelMode, raceStarts, tyreTemperature,
    pitLaneTyreSim, carDamage, carDamageRate, collisions, collisionsOffForFirstLapOnly,
    mpUnsafePitRelease, mpOffForGriefing, cornerCuttingStringency, parcFermeRules,
    pitStopExperience, safetyCar, safetyCarExperience, formationLap,
    formationLapExperience, redFlags, affectsLicenceLevelSolo, affectsLicenceLevelMP,
    numSessionsInWeekend, weekendStructure, sector2LapDistanceStart, sector3LapDistanceStart,
    activeAeroTrackStatus, numActiveAeroZonesFull, activeAeroZonesFull,
    numActiveAeroZonesPartial, activeAeroZonesPartial, numDRSZones, drsZones,
    startReactionTime, antiLockBrakesAssist, tractionControlAssist,
    dynamicRacingLineHiVis, dynamicRacingLineColourBlind, recurringRewindPrompt,
  };
}

// ---------------------------------------------------------------------
// LapData — 1399 bytes total = 29 (header) + 24 * 57 + 2. Struct
// unchanged from F25 — only NUM_CARS differs.
// ---------------------------------------------------------------------

export interface LapData26 {
  lastLapTimeInMS: number;
  currentLapTimeInMS: number;
  sector1TimeMSPart: number;
  sector1TimeMinutesPart: number;
  sector2TimeMSPart: number;
  sector2TimeMinutesPart: number;
  deltaToCarInFrontMSPart: number;
  deltaToCarInFrontMinutesPart: number;
  deltaToRaceLeaderMSPart: number;
  deltaToRaceLeaderMinutesPart: number;
  lapDistance: number;
  totalDistance: number;
  safetyCarDelta: number;
  carPosition: number;
  currentLapNum: number;
  pitStatus: number;
  numPitStops: number;
  sector: number;
  currentLapInvalid: number;
  penalties: number;
  totalWarnings: number;
  cornerCuttingWarnings: number;
  numUnservedDriveThroughPens: number;
  numUnservedStopGoPens: number;
  gridPosition: number;
  driverStatus: number;
  resultStatus: number;
  pitLaneTimerActive: number;
  pitLaneTimeInLaneInMS: number;
  pitStopTimerInMS: number;
  pitStopShouldServePen: number;
  speedTrapFastestSpeed: number;
  speedTrapFastestLap: number;
}

export interface PacketLapData26 {
  header: PacketHeader;
  lapData: LapData26[];
  timeTrialPBCarIdx: number;
  timeTrialRivalCarIdx: number;
}

function readLapData26(r: Reader): LapData26 {
  return {
    lastLapTimeInMS: r.u32(),
    currentLapTimeInMS: r.u32(),
    sector1TimeMSPart: r.u16(),
    sector1TimeMinutesPart: r.u8(),
    sector2TimeMSPart: r.u16(),
    sector2TimeMinutesPart: r.u8(),
    deltaToCarInFrontMSPart: r.u16(),
    deltaToCarInFrontMinutesPart: r.u8(),
    deltaToRaceLeaderMSPart: r.u16(),
    deltaToRaceLeaderMinutesPart: r.u8(),
    lapDistance: r.f32(),
    totalDistance: r.f32(),
    safetyCarDelta: r.f32(),
    carPosition: r.u8(),
    currentLapNum: r.u8(),
    pitStatus: r.u8(),
    numPitStops: r.u8(),
    sector: r.u8(),
    currentLapInvalid: r.u8(),
    penalties: r.u8(),
    totalWarnings: r.u8(),
    cornerCuttingWarnings: r.u8(),
    numUnservedDriveThroughPens: r.u8(),
    numUnservedStopGoPens: r.u8(),
    gridPosition: r.u8(),
    driverStatus: r.u8(),
    resultStatus: r.u8(),
    pitLaneTimerActive: r.u8(),
    pitLaneTimeInLaneInMS: r.u16(),
    pitStopTimerInMS: r.u16(),
    pitStopShouldServePen: r.u8(),
    speedTrapFastestSpeed: r.f32(),
    speedTrapFastestLap: r.u8(),
  };
}

export function parseLapData26(buf: Buffer): PacketLapData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const lapData: LapData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) lapData.push(readLapData26(r));
  const timeTrialPBCarIdx = r.u8();
  const timeTrialRivalCarIdx = r.u8();
  return { header, lapData, timeTrialPBCarIdx, timeTrialRivalCarIdx };
}

// ---------------------------------------------------------------------
// Participants — 1470 bytes total = 29 (header) + 1 (numActiveCars)
// + 24 * 60. driverId/networkId/teamId widened uint8 -> uint16 vs F25.
// ---------------------------------------------------------------------

export interface LiveryColour26 {
  red: number;
  green: number;
  blue: number;
}

export interface ParticipantData26 {
  aiControlled: number;
  driverId: number;
  networkId: number;
  teamId: number;
  myTeam: number;
  raceNumber: number;
  nationality: number;
  name: string;
  yourTelemetry: number;
  showOnlineNames: number;
  techLevel: number;
  platform: number;
  numColours: number;
  liveryColours: LiveryColour26[];
}

export interface PacketParticipantsData26 {
  header: PacketHeader;
  numActiveCars: number;
  participants: ParticipantData26[];
}

function readLiveryColour26(r: Reader): LiveryColour26 {
  return { red: r.u8(), green: r.u8(), blue: r.u8() };
}

function readParticipantData26(r: Reader): ParticipantData26 {
  const aiControlled = r.u8();
  const driverId = r.u16(); // widened from u8 in F25
  const networkId = r.u16(); // widened from u8 in F25
  const teamId = r.u16(); // widened from u8 in F25
  const myTeam = r.u8();
  const raceNumber = r.u8();
  const nationality = r.u8();
  const name = r.cstr(32);
  const yourTelemetry = r.u8();
  const showOnlineNames = r.u8();
  const techLevel = r.u16();
  const platform = r.u8();
  const numColours = r.u8();
  const liveryColours: LiveryColour26[] = [];
  for (let i = 0; i < 4; i++) liveryColours.push(readLiveryColour26(r));

  return {
    aiControlled, driverId, networkId, teamId, myTeam, raceNumber, nationality,
    name, yourTelemetry, showOnlineNames, techLevel, platform, numColours, liveryColours,
  };
}

export function parseParticipants26(buf: Buffer): PacketParticipantsData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const numActiveCars = r.u8();
  const participants: ParticipantData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) participants.push(readParticipantData26(r));
  return { header, numActiveCars, participants };
}

// ---------------------------------------------------------------------
// CarTelemetry — 1448 bytes total = 29 (header) + 24 * 59 + 3.
// engineTemperature narrowed uint16 -> uint8 vs F25.
// ---------------------------------------------------------------------

export interface CarTelemetryData26 {
  speed: number;
  throttle: number;
  steer: number;
  brake: number;
  clutch: number;
  gear: number;
  engineRPM: number;
  drs: number;
  revLightsPercent: number;
  revLightsBitValue: number;
  brakesTemperature: [number, number, number, number];
  tyresSurfaceTemperature: [number, number, number, number];
  tyresInnerTemperature: [number, number, number, number];
  engineTemperature: number;
  tyresPressure: [number, number, number, number];
  surfaceType: [number, number, number, number];
}

export interface PacketCarTelemetryData26 {
  header: PacketHeader;
  carTelemetryData: CarTelemetryData26[];
  mfdPanelIndex: number;
  mfdPanelIndexSecondaryPlayer: number;
  suggestedGear: number;
}

function readCarTelemetryData26(r: Reader): CarTelemetryData26 {
  return {
    speed: r.u16(),
    throttle: r.f32(),
    steer: r.f32(),
    brake: r.f32(),
    clutch: r.u8(),
    gear: r.i8(),
    engineRPM: r.u16(),
    drs: r.u8(),
    revLightsPercent: r.u8(),
    revLightsBitValue: r.u16(),
    brakesTemperature: readWheelArrayU16(r),
    tyresSurfaceTemperature: readWheelArrayU8(r),
    tyresInnerTemperature: readWheelArrayU8(r),
    engineTemperature: r.u8(), // narrowed from u16 in F25
    tyresPressure: readWheelArrayF32(r),
    surfaceType: readWheelArrayU8(r),
  };
}

export function parseCarTelemetry26(buf: Buffer): PacketCarTelemetryData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carTelemetryData: CarTelemetryData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) carTelemetryData.push(readCarTelemetryData26(r));
  const mfdPanelIndex = r.u8();
  const mfdPanelIndexSecondaryPlayer = r.u8();
  const suggestedGear = r.i8();
  return { header, carTelemetryData, mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear };
}

// ---------------------------------------------------------------------
// CarStatus — 1445 bytes total = 29 (header) + 24 * 59. New field
// ersHarvestLimitPerLap added vs F25.
// ---------------------------------------------------------------------

export interface CarStatusData26 {
  tractionControl: number;
  antiLockBrakes: number;
  fuelMix: number;
  frontBrakeBias: number;
  pitLimiterStatus: number;
  fuelInTank: number;
  fuelCapacity: number;
  fuelRemainingLaps: number;
  maxRPM: number;
  idleRPM: number;
  maxGears: number;
  drsAllowed: number;
  drsActivationDistance: number;
  actualTyreCompound: number;
  visualTyreCompound: number;
  tyresAgeLaps: number;
  vehicleFiaFlags: number;
  enginePowerICE: number;
  enginePowerMGUK: number;
  ersStoreEnergy: number;
  ersDeployMode: number;
  ersHarvestedThisLapMGUK: number;
  ersHarvestedThisLapMGUH: number;
  /** New in F26 — inserted between ersHarvestedThisLapMGUH and ersDeployedThisLap. */
  ersHarvestLimitPerLap: number;
  ersDeployedThisLap: number;
  networkPaused: number;
}

export interface PacketCarStatusData26 {
  header: PacketHeader;
  carStatusData: CarStatusData26[];
}

function readCarStatusData26(r: Reader): CarStatusData26 {
  return {
    tractionControl: r.u8(),
    antiLockBrakes: r.u8(),
    fuelMix: r.u8(),
    frontBrakeBias: r.u8(),
    pitLimiterStatus: r.u8(),
    fuelInTank: r.f32(),
    fuelCapacity: r.f32(),
    fuelRemainingLaps: r.f32(),
    maxRPM: r.u16(),
    idleRPM: r.u16(),
    maxGears: r.u8(),
    drsAllowed: r.u8(),
    drsActivationDistance: r.u16(),
    actualTyreCompound: r.u8(),
    visualTyreCompound: r.u8(),
    tyresAgeLaps: r.u8(),
    vehicleFiaFlags: r.i8(),
    enginePowerICE: r.f32(),
    enginePowerMGUK: r.f32(),
    ersStoreEnergy: r.f32(),
    ersDeployMode: r.u8(),
    ersHarvestedThisLapMGUK: r.f32(),
    ersHarvestedThisLapMGUH: r.f32(),
    ersHarvestLimitPerLap: r.f32(), // new in F26
    ersDeployedThisLap: r.f32(),
    networkPaused: r.u8(),
  };
}

export function parseCarStatus26(buf: Buffer): PacketCarStatusData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carStatusData: CarStatusData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) carStatusData.push(readCarStatusData26(r));
  return { header, carStatusData };
}

// ---------------------------------------------------------------------
// CarDamage — 1133 bytes total = 29 (header) + 24 * 46. Struct
// unchanged from F25 — only NUM_CARS differs.
// ---------------------------------------------------------------------

export interface CarDamageData26 {
  tyresWear: [number, number, number, number];
  tyresDamage: [number, number, number, number];
  brakesDamage: [number, number, number, number];
  tyreBlisters: [number, number, number, number];
  frontLeftWingDamage: number;
  frontRightWingDamage: number;
  rearWingDamage: number;
  floorDamage: number;
  diffuserDamage: number;
  sidepodDamage: number;
  drsFault: number;
  ersFault: number;
  gearBoxDamage: number;
  engineDamage: number;
  engineMGUHWear: number;
  engineESWear: number;
  engineCEWear: number;
  engineICEWear: number;
  engineMGUKWear: number;
  engineTCWear: number;
  engineBlown: number;
  engineSeized: number;
}

export interface PacketCarDamageData26 {
  header: PacketHeader;
  carDamageData: CarDamageData26[];
}

function readCarDamageData26(r: Reader): CarDamageData26 {
  return {
    tyresWear: readWheelArrayF32(r),
    tyresDamage: readWheelArrayU8(r),
    brakesDamage: readWheelArrayU8(r),
    tyreBlisters: readWheelArrayU8(r),
    frontLeftWingDamage: r.u8(),
    frontRightWingDamage: r.u8(),
    rearWingDamage: r.u8(),
    floorDamage: r.u8(),
    diffuserDamage: r.u8(),
    sidepodDamage: r.u8(),
    drsFault: r.u8(),
    ersFault: r.u8(),
    gearBoxDamage: r.u8(),
    engineDamage: r.u8(),
    engineMGUHWear: r.u8(),
    engineESWear: r.u8(),
    engineCEWear: r.u8(),
    engineICEWear: r.u8(),
    engineMGUKWear: r.u8(),
    engineTCWear: r.u8(),
    engineBlown: r.u8(),
    engineSeized: r.u8(),
  };
}

export function parseCarDamage26(buf: Buffer): PacketCarDamageData26 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carDamageData: CarDamageData26[] = [];
  for (let i = 0; i < NUM_CARS; i++) carDamageData.push(readCarDamageData26(r));
  return { header, carDamageData };
}
