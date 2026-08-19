// header.ts — PacketHeader parsing, common to every packet in every
// supported game year.
//
// F1 23 / 24 / 25 / 26 all share ONE 29-byte header layout. This was
// verified against the official EA-licensed specs (community mirrors
// of the EA forum posts, cross-checked across three independent
// sources for F1 23, 24, and 25):
//   - F1 23: https://github.com/MacManley/f1-23-udp (mirrors
//            https://answers.ea.com/t5/General-Discussion/F1-23-UDP-Specification/m-p/12633159)
//   - F1 24: https://github.com/MacManley/f1-24-udp
//   - F1 25: Data Output from F1 25 v3 (EA forums PDF)
//
// F1 23's own changelog confirms this explicitly: "Added overall frame
// identifier to packet header to help deal with flashbacks." That
// field (m_overallFrameIdentifier, uint32) is what pushed the header
// from 25 bytes (F1 22 and earlier) to 29 bytes -- and it's present
// starting in F1 23, not introduced later. An earlier draft of this
// file incorrectly treated F1 23 as still having the 25-byte header;
// that was wrong and has been corrected here.
//
// F1 25 "2026 Season Pack" ships as a UDP *format toggle inside F1 25*
// (menu option, not a separate game). Treat game_year 26 the same as
// 25 unless a capture proves otherwise -- see README "2026 season
// pack" section.

export const HEADER_SIZE_BYTES = 29; // shared by all four supported years

export type TelemetryYear = 23 | 24 | 25 | 26;

// Only the packet IDs this project actually captures. EA's spec defines
// more (Event=3, CarSetups=5, FinalClassification=8, LobbyInfo=9,
// SessionHistory=11, TyreSets=12, MotionEx=13, TimeTrial=14,
// LapPositions=15) -- deliberately omitted since dispatch23/24/25/26 in
// parser.ts don't handle them and would just fall through to `default:
// return null` anyway.
export enum PacketId {
  Motion = 0,
  Session = 1,
  LapData = 2,
  Participants = 4,
  CarTelemetry = 6,
  CarStatus = 7,
  CarDamage = 10,
}

export interface PacketHeader {
  packetFormat: number; // 2023 / 2024 / 2025 / 2026
  gameYear: number; // 23 / 24 / 25 / 26
  gameMajorVersion: number;
  gameMinorVersion: number;
  packetVersion: number;
  packetId: number;
  sessionUid: bigint;
  sessionTime: number;
  frameIdentifier: number;
  overallFrameIdentifier: number;
  playerCarIndex: number;
  secondaryPlayerCarIndex: number;
  headerSize: number;
}

/**
 * Maps a header's packetFormat to the TelemetryYear used to select a
 * per-year parser module. Returns null for anything outside 23-26 (a
 * future/unsupported game year, an old pre-23 format, or a garbage/
 * non-header buffer that happened to produce a plausible-looking
 * uint16).
 */
export function resolveTelemetryYear(header: PacketHeader): TelemetryYear | null {
  switch (header.packetFormat) {
    case 2023:
      return 23;
    case 2024:
      return 24;
    case 2025:
      return 25;
    case 2026:
      return 26;
    default:
      return null;
  }
}

/**
 * Parses a PacketHeader from the start of a UDP datagram. Fixed
 * 29-byte layout, identical across F1 23/24/25/26 -- see the header
 * comment above for why this is a single format rather than
 * branching by year.
 *
 * Throws RangeError (via Buffer's built-in bounds checking) if buf is
 * shorter than HEADER_SIZE_BYTES -- callers should catch this and
 * treat it as "malformed/truncated packet, skip it," same as
 * parser.ts's parsePacket() does for its own too-short check.
 */
export function parseHeader(buf: Buffer): PacketHeader {
  if (buf.length < HEADER_SIZE_BYTES) {
    throw new RangeError('buffer too short to contain a PacketHeader');
  }

  let offset = 0;
  const packetFormat = buf.readUInt16LE(offset); offset += 2;
  const gameYear = buf.readUInt8(offset); offset += 1;
  const gameMajorVersion = buf.readUInt8(offset); offset += 1;
  const gameMinorVersion = buf.readUInt8(offset); offset += 1;
  const packetVersion = buf.readUInt8(offset); offset += 1;
  const packetId = buf.readUInt8(offset); offset += 1;
  const sessionUid = buf.readBigUInt64LE(offset); offset += 8;
  const sessionTime = buf.readFloatLE(offset); offset += 4;
  const frameIdentifier = buf.readUInt32LE(offset); offset += 4;
  const overallFrameIdentifier = buf.readUInt32LE(offset); offset += 4;
  const playerCarIndex = buf.readUInt8(offset); offset += 1;
  const secondaryPlayerCarIndex = buf.readUInt8(offset); offset += 1;

  return {
    packetFormat,
    gameYear,
    gameMajorVersion,
    gameMinorVersion,
    packetVersion,
    packetId,
    sessionUid,
    sessionTime,
    frameIdentifier,
    overallFrameIdentifier,
    playerCarIndex,
    secondaryPlayerCarIndex,
    headerSize: HEADER_SIZE_BYTES,
  };
}
