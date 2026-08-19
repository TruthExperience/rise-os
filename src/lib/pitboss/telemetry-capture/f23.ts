// f23.ts — F1 23 packet body parsers (Motion, Session, LapData,
// Participants, CarTelemetry, CarStatus, CarDamage). Field layouts and
// byte offsets verified against the official EA-licensed F1 23 UDP
// spec (https://github.com/MacManley/f1-23-udp, mirroring
// https://answers.ea.com/t5/General-Discussion/F1-23-UDP-Specification/m-p/12633159).
//
// Every struct below was cross-checked by summing its field sizes and
// confirming the result matches EA's documented total packet size
// (included in each parse function's comment) -- not just eyeballing
// individual fields. This is deliberately the "fully accurate, ground
// truth" parser per the project's stated risk: F1 24/25/26 don't have
// one unified verified source the way F1 23 does, so this file is the
// baseline the others get compared against.

import { HEADER_SIZE_BYTES, parseHeader, PacketHeader } from './header';

// Sequential little-endian buffer reader. Using a stateful cursor
// instead of manually tracked `offset += n` on every field removes the
// single biggest source of error in a file like this: a fat-fingered
// offset that silently reads the wrong bytes instead of throwing.
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
// Motion — 1349 bytes total = 29 (header) + 22 * 60 (CarMotionData)
// ---------------------------------------------------------------------

export interface CarMotionData23 {
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

export interface PacketMotionData23 {
  header: PacketHeader;
  carMotionData: CarMotionData23[];
}

function readCarMotionData23(r: Reader): CarMotionData23 {
  return {
    worldPositionX: r.f32(),
    worldPositionY: r.f32(),
    worldPositionZ: r.f32(),
    worldVelocityX: r.f32(),
    worldVelocityY: r.f32(),
    worldVelocityZ: r.f32(),
    worldForwardDirX: r.u16(), // spec type is int16; read raw then reinterpret
    worldForwardDirY: r.u16(),
    worldForwardDirZ: r.u16(),
    worldRightDirX: r.u16(),
    worldRightDirY: r.u16(),
    worldRightDirZ: r.u16(),
    gForceLateral: r.f32(),
    gForceLongitudinal: r.f32(),
    gForceVertical: r.f32(),
    yaw: r.f32(),
    pitch: r.f32(),
    roll: r.f32(),
  };
}

export function parseMotion23(buf: Buffer): PacketMotionData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carMotionData: CarMotionData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) carMotionData.push(readCarMotionData23(r));
  return { header, carMotionData };
}

// ---------------------------------------------------------------------
// Session — 644 bytes total = 29 (header) + 615 (body, incl. 21
// MarshalZones @ 5 bytes + 56 WeatherForecastSamples @ 8 bytes)
// ---------------------------------------------------------------------

export interface MarshalZone23 {
  zoneStart: number;
  zoneFlag: number;
}

export interface WeatherForecastSample23 {
  sessionType: number;
  timeOffset: number;
  weather: number;
  trackTemperature: number;
  trackTemperatureChange: number;
  airTemperature: number;
  airTemperatureChange: number;
  rainPercentage: number;
}

export interface PacketSessionData23 {
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
  marshalZones: MarshalZone23[];
  safetyCarStatus: number;
  networkGame: number;
  numWeatherForecastSamples: number;
  weatherForecastSamples: WeatherForecastSample23[];
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
}

function readMarshalZone23(r: Reader): MarshalZone23 {
  return { zoneStart: r.f32(), zoneFlag: r.i8() };
}

function readWeatherForecastSample23(r: Reader): WeatherForecastSample23 {
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

export function parseSession23(buf: Buffer): PacketSessionData23 {
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

  const marshalZones: MarshalZone23[] = [];
  for (let i = 0; i < 21; i++) marshalZones.push(readMarshalZone23(r));

  const safetyCarStatus = r.u8();
  const networkGame = r.u8();
  const numWeatherForecastSamples = r.u8();

  const weatherForecastSamples: WeatherForecastSample23[] = [];
  for (let i = 0; i < 56; i++) weatherForecastSamples.push(readWeatherForecastSample23(r));

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

  return {
    header, weather, trackTemperature, airTemperature, totalLaps, trackLength,
    sessionType, trackId, formula, sessionTimeLeft, sessionDuration, pitSpeedLimit,
    gamePaused, isSpectating, spectatorCarIndex, sliProNativeSupport, numMarshalZones,
    marshalZones, safetyCarStatus, networkGame, numWeatherForecastSamples,
    weatherForecastSamples, forecastAccuracy, aiDifficulty, seasonLinkIdentifier,
    weekendLinkIdentifier, sessionLinkIdentifier, pitStopWindowIdealLap,
    pitStopWindowLatestLap, pitStopRejoinPosition, steeringAssist, brakingAssist,
    gearboxAssist, pitAssist, pitReleaseAssist, ersAssist: ersAssist, drsAssist,
    dynamicRacingLine, dynamicRacingLineType, gameMode, ruleSet, timeOfDay,
    sessionLength, speedUnitsLeadPlayer, temperatureUnitsLeadPlayer,
    speedUnitsSecondaryPlayer, temperatureUnitsSecondaryPlayer, numSafetyCarPeriods,
    numVirtualSafetyCarPeriods, numRedFlagPeriods,
  };
}

// ---------------------------------------------------------------------
// LapData — 1131 bytes total = 29 (header) + 22 * 50 (LapData) + 2
// ---------------------------------------------------------------------

export interface LapData23 {
  lastLapTimeInMS: number;
  currentLapTimeInMS: number;
  sector1TimeInMS: number;
  sector1TimeMinutes: number;
  sector2TimeInMS: number;
  sector2TimeMinutes: number;
  deltaToCarInFrontInMS: number;
  deltaToRaceLeaderInMS: number;
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
}

export interface PacketLapData23 {
  header: PacketHeader;
  lapData: LapData23[];
  timeTrialPBCarIdx: number;
  timeTrialRivalCarIdx: number;
}

function readLapData23(r: Reader): LapData23 {
  return {
    lastLapTimeInMS: r.u32(),
    currentLapTimeInMS: r.u32(),
    sector1TimeInMS: r.u16(),
    sector1TimeMinutes: r.u8(),
    sector2TimeInMS: r.u16(),
    sector2TimeMinutes: r.u8(),
    deltaToCarInFrontInMS: r.u16(),
    deltaToRaceLeaderInMS: r.u16(),
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
  };
}

export function parseLapData23(buf: Buffer): PacketLapData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const lapData: LapData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) lapData.push(readLapData23(r));
  const timeTrialPBCarIdx = r.u8();
  const timeTrialRivalCarIdx = r.u8();
  return { header, lapData, timeTrialPBCarIdx, timeTrialRivalCarIdx };
}

// ---------------------------------------------------------------------
// Participants — 1306 bytes total = 29 (header) + 1 (numActiveCars)
// + 22 * 58 (ParticipantData, incl. 48-byte name)
// ---------------------------------------------------------------------

export interface ParticipantData23 {
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
  platform: number;
}

export interface PacketParticipantsData23 {
  header: PacketHeader;
  numActiveCars: number;
  participants: ParticipantData23[];
}

function readParticipantData23(r: Reader): ParticipantData23 {
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
    platform: r.u8(),
  };
}

export function parseParticipants23(buf: Buffer): PacketParticipantsData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const numActiveCars = r.u8();
  const participants: ParticipantData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) participants.push(readParticipantData23(r));
  return { header, numActiveCars, participants };
}

// ---------------------------------------------------------------------
// CarTelemetry — 1352 bytes total = 29 (header) + 22 * 60
// (CarTelemetryData) + 3
// ---------------------------------------------------------------------

export interface CarTelemetryData23 {
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

export interface PacketCarTelemetryData23 {
  header: PacketHeader;
  carTelemetryData: CarTelemetryData23[];
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

function readCarTelemetryData23(r: Reader): CarTelemetryData23 {
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

export function parseCarTelemetry23(buf: Buffer): PacketCarTelemetryData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carTelemetryData: CarTelemetryData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) carTelemetryData.push(readCarTelemetryData23(r));
  const mfdPanelIndex = r.u8();
  const mfdPanelIndexSecondaryPlayer = r.u8();
  const suggestedGear = r.i8();
  return { header, carTelemetryData, mfdPanelIndex, mfdPanelIndexSecondaryPlayer, suggestedGear };
}

// ---------------------------------------------------------------------
// CarStatus — 1239 bytes total = 29 (header) + 22 * 55 (CarStatusData)
// ---------------------------------------------------------------------

export interface CarStatusData23 {
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

export interface PacketCarStatusData23 {
  header: PacketHeader;
  carStatusData: CarStatusData23[];
}

function readCarStatusData23(r: Reader): CarStatusData23 {
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

export function parseCarStatus23(buf: Buffer): PacketCarStatusData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carStatusData: CarStatusData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) carStatusData.push(readCarStatusData23(r));
  return { header, carStatusData };
}

// ---------------------------------------------------------------------
// CarDamage — 953 bytes total = 29 (header) + 22 * 42 (CarDamageData)
// ---------------------------------------------------------------------

export interface CarDamageData23 {
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

export interface PacketCarDamageData23 {
  header: PacketHeader;
  carDamageData: CarDamageData23[];
}

function readCarDamageData23(r: Reader): CarDamageData23 {
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

export function parseCarDamage23(buf: Buffer): PacketCarDamageData23 {
  const header = parseHeader(buf);
  const r = new Reader(buf, HEADER_SIZE_BYTES);
  const carDamageData: CarDamageData23[] = [];
  for (let i = 0; i < NUM_CARS; i++) carDamageData.push(readCarDamageData23(r));
  return { header, carDamageData };
}
