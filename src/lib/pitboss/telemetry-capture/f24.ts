// f24.ts — F1 24 packet body parsers (Motion, Session, LapData,
// Participants, CarTelemetry, CarStatus, CarDamage). Field layouts and
// byte offsets verified against the official EA-licensed F1 24 UDP
// spec (https://github.com/MacManley/f1-24-udp), which itself mirrors
// https://answers.ea.com/t5/General-Discussion/F1-24-UDP-Specification/td-p/13745220.
//
// Every struct below was cross-checked by summing its field sizes and
// confirming the result matches EA's documented total packet size
// (noted in each parse function's comment), the same standard f23.ts
// was held to.
//
// What changed vs F1 23 (per EA's official changelog, all reflected below):
//   - Session: ~30 new sim/rules fields + weekend structure array +
//     sector 2/3 distance-start floats; weather forecast array grew
//     from 56 to 64 samples. Total size 644 -> 753 bytes.
//   - LapData: sector/delta fields split into MS + whole-minute parts,
//     plus two new speed-trap fields. Per-car size 50 -> 57 bytes,
//     total 1131 -> 1285 bytes.
//   - Participants: added `techLevel` (uint16) before `platform`.
//     Per-car size 58 -> 60 bytes, total 1306 -> 1350 bytes.
//   - Motion, CarTelemetry, CarStatus, CarDamage: unchanged from F23.
//
// Unlike f23.ts, worldForwardDir/worldRightDir here are read with the
// new i16() method (the spec marks them signed, normalised -32767..32767)
// rather than u16() — f23.ts flagged that gap as a known TODO; fixed here.

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

const NUM_CARS = 22;

// ---------------------------------------------------------------------
// Motion — 1349 bytes total = 29 (header) + 22 * 60 (CarMotionData).
// Unchanged from F23, except forward/right dir now read as signed.
// ---------------------------------------------------------------------

export interface CarMotionData24 {
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
  gForceLateral: number;
  gForceLongitudinal: number;
  gForceVertical: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface PacketMotionData24 {
  header: PacketHeader;
  carMotionData: CarMotionData24[];
}

function readCarMotionData24(r: Reader): CarMotionData24 {
  return {
    worldPositionX: r.f32(),
    worldPositionY: r.f32(),
    worldPositionZ: r.f32(),
    worldVelocityX: r.f32(),
    worldVelocityY: r.f32(),
    worldVelocityZ: r.f32(),
    worldForwardDirX: r.i16(), // signed, normalised — divide by 32767.0 for float
    worldForwardDirY: r.i16(),
    worldForwardDirZ: r.i16(),
    worldRightDirX: r.i16(),
    worldRightDirY: r.i16(),
    worldRightDirZ: r.i16(),
    gForceLateral: r.f32(),
    gForceLongitudinal: r.f32(),
    gForceVertical: r.f32(),
    yaw: r.f32(),
    pitch: r.f32(),
    roll: r.f32(),
  };
}

export function parseMotion24(buf: Buffer): PacketMotionData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carMotionData: CarMotionData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) carMotionData.push(readCarMotionData24(r));
  return { header, carMotionData };
}

// ---------------------------------------------------------------------
// Session — 753 bytes total = 29 (header) + 724 (body, incl. 21
// MarshalZones @ 5 bytes + 64 WeatherForecastSamples @ 8 bytes +
// 12-byte weekendStructure array)
// ---------------------------------------------------------------------

export interface MarshalZone24 {
  zoneStart: number;
  zoneFlag: number;
}

export interface WeatherForecastSample24 {
  sessionType: number;
  timeOffset: number;
  weather: number;
  trackTemperature: number;
  trackTemperatureChange: number;
  airTemperature: number;
  airTemperatureChange: number;
  rainPercentage: number;
}

export interface PacketSessionData24 {
  header: PacketHeader;
  weather: number;
  trackTemperature: number;
  airTemperature: number;
  totalLaps: number;
  trackLength: number;
  sessionType: number;
  trackId: number;
  formula: number;
  sessionTimeLeft: number;
  sessionDuration: number;
  pitSpeedLimit: number;
  gamePaused: number;
  isSpectating: number;
  spectatorCarIndex: number;
  sliProNativeSupport: number;
  numMarshalZones: number;
  marshalZones: MarshalZone24[];
  safetyCarStatus: number;
  networkGame: number;
  numWeatherForecastSamples: number;
  weatherForecastSamples: WeatherForecastSample24[];
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
  // --- new in F24 ---
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
}

function readMarshalZone24(r: Reader): MarshalZone24 {
  return { zoneStart: r.f32(), zoneFlag: r.i8() };
}

function readWeatherForecastSample24(r: Reader): WeatherForecastSample24 {
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

export function parseSession24(buf: Buffer): PacketSessionData24 {
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

  const marshalZones: MarshalZone24[] = [];
  for (let i = 0; i < 21; i++) marshalZones.push(readMarshalZone24(r));

  const safetyCarStatus = r.u8();
  const networkGame = r.u8();
  const numWeatherForecastSamples = r.u8();

  const weatherForecastSamples: WeatherForecastSample24[] = [];
  for (let i = 0; i < 64; i++) weatherForecastSamples.push(readWeatherForecastSample24(r));

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
  };
}

// ---------------------------------------------------------------------
// LapData — 1285 bytes total = 29 (header) + 22 * 57 (LapData) + 2
// ---------------------------------------------------------------------

export interface LapData24 {
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

export interface PacketLapData24 {
  header: PacketHeader;
  lapData: LapData24[];
  timeTrialPBCarIdx: number;
  timeTrialRivalCarIdx: number;
}

function readLapData24(r: Reader): LapData24 {
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

export function parseLapData24(buf: Buffer): PacketLapData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const lapData: LapData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) lapData.push(readLapData24(r));
  const timeTrialPBCarIdx = r.u8();
  const timeTrialRivalCarIdx = r.u8();
  return { header, lapData, timeTrialPBCarIdx, timeTrialRivalCarIdx };
}

// ---------------------------------------------------------------------
// Participants — 1350 bytes total = 29 (header) + 1 (numActiveCars)
// + 22 * 60 (ParticipantData, incl. 48-byte name + new techLevel)
// ---------------------------------------------------------------------

export interface ParticipantData24 {
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
}

export interface PacketParticipantsData24 {
  header: PacketHeader;
  numActiveCars: number;
  participants: ParticipantData24[];
}

function readParticipantData24(r: Reader): ParticipantData24 {
  return {
    aiControlled: r.u8(),
    driverId: r.u8(),
    networkId: r.u8(),
    teamId: r.u8(),
    myTeam: r.u8(),
    raceNumber: r.u8(),
    nationality: r.u8(),
    name: r.cstr(48),
    yourTelemetry: r.u8(),
    showOnlineNames: r.u8(),
    techLevel: r.u16(),
    platform: r.u8(),
  };
}

export function parseParticipants24(buf: Buffer): PacketParticipantsData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const numActiveCars = r.u8();
  const participants: ParticipantData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) participants.push(readParticipantData24(r));
  return { header, numActiveCars, participants };
}

// ---------------------------------------------------------------------
// CarTelemetry — 1352 bytes total = 29 (header) + 22 * 60
// (CarTelemetryData) + 3. Unchanged from F23.
// ---------------------------------------------------------------------

export interface CarTelemetryData24 {
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

export interface PacketCarTelemetryData24 {
  header: PacketHeader;
  carTelemetryData: CarTelemetryData24[];
  mfdPanelIndex: number;
  mfdPanelIndexSecondaryPlayer: number;
  suggestedGear: number;
}

function readWheelArrayU16(r: Reader): [number, number, number, number] {
  return [r.u16(), r.u16(), r.u16(), r.u16()];
}
function readWheelArrayU8(r: Reader): [number, number, number, number] {
  return [r.u8(), r.u8(), r.u8(), r.u8()];
}
function readWheelArrayF32(r: Reader): [number, number, number, number] {
  return [r.f32(), r.f32(), r.f32(), r.f32()];
}

function readCarTelemetryData24(r: Reader): CarTelemetryData24 {
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
    engineTemperature: r.u16(),
    tyresPressure: readWheelArrayF32(r),
    surfaceType: readWheelArrayU8(r),
  };
}

export function parseCarTelemetry24(buf: Buffer): PacketCarTelemetryData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carTelemetryData: CarTelemetryData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) carTelemetryData.push(readCarTelemetryData24(r));
  const mfdPanelIndex = r.u8();
  const mfdPanelIndexSecondaryPlayer = r.u8();
  const suggestedGear = r.i8();
  return { header, carTelemetryData, mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear };
}

// ---------------------------------------------------------------------
// CarStatus — 1239 bytes total = 29 (header) + 22 * 55 (CarStatusData).
// Unchanged from F23.
// ---------------------------------------------------------------------

export interface CarStatusData24 {
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
  ersDeployedThisLap: number;
  networkPaused: number;
}

export interface PacketCarStatusData24 {
  header: PacketHeader;
  carStatusData: CarStatusData24[];
}

function readCarStatusData24(r: Reader): CarStatusData24 {
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
    ersDeployedThisLap: r.f32(),
    networkPaused: r.u8(),
  };
}

export function parseCarStatus24(buf: Buffer): PacketCarStatusData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carStatusData: CarStatusData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) carStatusData.push(readCarStatusData24(r));
  return { header, carStatusData };
}

// ---------------------------------------------------------------------
// CarDamage — 953 bytes total = 29 (header) + 22 * 42 (CarDamageData).
// Unchanged from F23.
// ---------------------------------------------------------------------

export interface CarDamageData24 {
  tyresWear: [number, number, number, number];
  tyresDamage: [number, number, number, number];
  brakesDamage: [number, number, number, number];
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

export interface PacketCarDamageData24 {
  header: PacketHeader;
  carDamageData: CarDamageData24[];
}

function readCarDamageData24(r: Reader): CarDamageData24 {
  return {
    tyresWear: readWheelArrayF32(r),
    tyresDamage: readWheelArrayU8(r),
    brakesDamage: readWheelArrayU8(r),
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

export function parseCarDamage24(buf: Buffer): PacketCarDamageData24 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carDamageData: CarDamageData24[] = [];
  for (let i = 0; i < NUM_CARS; i++) carDamageData.push(readCarDamageData24(r));
  return { header, carDamageData };
}
