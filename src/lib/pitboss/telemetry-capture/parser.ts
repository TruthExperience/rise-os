// parser.ts — Top-level entry point. Peeks the header to determine spec year
// and packet type, then dispatches to the matching per-year parser.
// Only the 7 packet types we capture (Motion, Session, LapData, Participants,
// CarTelemetry, CarStatus, CarDamage) are wired up; anything else is ignored.

import { HEADER_SIZE_BYTES, PacketId, parseHeader, resolveTelemetryYear, TelemetryYear } from './header';

import * as F23 from './f23';
import * as F24 from './f24';
import * as F25 from './f25';
import * as F26 from './f26';

export type ParsedPacket =
  | { year: 23; kind: 'motion'; data: F23.PacketMotionData23 }
  | { year: 23; kind: 'session'; data: F23.PacketSessionData23 }
  | { year: 23; kind: 'lapData'; data: F23.PacketLapData23 }
  | { year: 23; kind: 'participants'; data: F23.PacketParticipantsData23 }
  | { year: 23; kind: 'carTelemetry'; data: F23.PacketCarTelemetryData23 }
  | { year: 23; kind: 'carStatus'; data: F23.PacketCarStatusData23 }
  | { year: 23; kind: 'carDamage'; data: F23.PacketCarDamageData23 }
  | { year: 24; kind: 'motion'; data: F24.PacketMotionData24 }
  | { year: 24; kind: 'session'; data: F24.PacketSessionData24 }
  | { year: 24; kind: 'lapData'; data: F24.PacketLapData24 }
  | { year: 24; kind: 'participants'; data: F24.PacketParticipantsData24 }
  | { year: 24; kind: 'carTelemetry'; data: F24.PacketCarTelemetryData24 }
  | { year: 24; kind: 'carStatus'; data: F24.PacketCarStatusData24 }
  | { year: 24; kind: 'carDamage'; data: F24.PacketCarDamageData24 }
  | { year: 25; kind: 'motion'; data: F25.PacketMotionData25 }
  | { year: 25; kind: 'session'; data: F25.PacketSessionData25 }
  | { year: 25; kind: 'lapData'; data: F25.PacketLapData25 }
  | { year: 25; kind: 'participants'; data: F25.PacketParticipantsData25 }
  | { year: 25; kind: 'carTelemetry'; data: F25.PacketCarTelemetryData25 }
  | { year: 25; kind: 'carStatus'; data: F25.PacketCarStatusData25 }
  | { year: 25; kind: 'carDamage'; data: F25.PacketCarDamageData25 }
  | { year: 26; kind: 'motion'; data: F26.PacketMotionData26 }
  | { year: 26; kind: 'session'; data: F26.PacketSessionData26 }
  | { year: 26; kind: 'lapData'; data: F26.PacketLapData26 }
  | { year: 26; kind: 'participants'; data: F26.PacketParticipantsData26 }
  | { year: 26; kind: 'carTelemetry'; data: F26.PacketCarTelemetryData26 }
  | { year: 26; kind: 'carStatus'; data: F26.PacketCarStatusData26 }
  | { year: 26; kind: 'carDamage'; data: F26.PacketCarDamageData26 };

/**
 * Parses a raw UDP datagram into a typed, year-tagged packet.
 * Returns null for packet types we don't capture, or if the packet is too
 * short / reports an unrecognised format (partial/corrupt UDP datagram).
 */
export function parsePacket(buf: Buffer): ParsedPacket | null {
  if (buf.length < HEADER_SIZE_BYTES) return null;

  let header;
  try {
    header = parseHeader(buf);
  } catch (err) {
    // The HEADER_SIZE_BYTES guard above already covers the normal
    // too-short case (all four supported years share one 29-byte
    // header, so there's no smaller format to fall through). This
    // catch is a defensive backstop for any other malformed input;
    // treat it the same as any other bad packet: skip it, don't crash
    // the listener.
    return null;
  }

  const year = resolveTelemetryYear(header);
  if (year === null) return null;

  switch (year) {
    case 23:
      return dispatch23(header.packetId, buf);
    case 24:
      return dispatch24(header.packetId, buf);
    case 25:
      return dispatch25(header.packetId, buf);
    case 26:
      return dispatch26(header.packetId, buf);
  }
}

function dispatch23(id: PacketId, buf: Buffer): ParsedPacket | null {
  switch (id) {
    case PacketId.Motion:
      return { year: 23, kind: 'motion', data: F23.parseMotion23(buf) };
    case PacketId.Session:
      return { year: 23, kind: 'session', data: F23.parseSession23(buf) };
    case PacketId.LapData:
      return { year: 23, kind: 'lapData', data: F23.parseLapData23(buf) };
    case PacketId.Participants:
      return { year: 23, kind: 'participants', data: F23.parseParticipants23(buf) };
    case PacketId.CarTelemetry:
      return { year: 23, kind: 'carTelemetry', data: F23.parseCarTelemetry23(buf) };
    case PacketId.CarStatus:
      return { year: 23, kind: 'carStatus', data: F23.parseCarStatus23(buf) };
    case PacketId.CarDamage:
      return { year: 23, kind: 'carDamage', data: F23.parseCarDamage23(buf) };
    default:
      return null;
  }
}

function dispatch24(id: PacketId, buf: Buffer): ParsedPacket | null {
  switch (id) {
    case PacketId.Motion:
      return { year: 24, kind: 'motion', data: F24.parseMotion24(buf) };
    case PacketId.Session:
      return { year: 24, kind: 'session', data: F24.parseSession24(buf) };
    case PacketId.LapData:
      return { year: 24, kind: 'lapData', data: F24.parseLapData24(buf) };
    case PacketId.Participants:
      return { year: 24, kind: 'participants', data: F24.parseParticipants24(buf) };
    case PacketId.CarTelemetry:
      return { year: 24, kind: 'carTelemetry', data: F24.parseCarTelemetry24(buf) };
    case PacketId.CarStatus:
      return { year: 24, kind: 'carStatus', data: F24.parseCarStatus24(buf) };
    case PacketId.CarDamage:
      return { year: 24, kind: 'carDamage', data: F24.parseCarDamage24(buf) };
    default:
      return null;
  }
}

function dispatch25(id: PacketId, buf: Buffer): ParsedPacket | null {
  switch (id) {
    case PacketId.Motion:
      return { year: 25, kind: 'motion', data: F25.parseMotion25(buf) };
    case PacketId.Session:
      return { year: 25, kind: 'session', data: F25.parseSession25(buf) };
    case PacketId.LapData:
      return { year: 25, kind: 'lapData', data: F25.parseLapData25(buf) };
    case PacketId.Participants:
      return { year: 25, kind: 'participants', data: F25.parseParticipants25(buf) };
    case PacketId.CarTelemetry:
      return { year: 25, kind: 'carTelemetry', data: F25.parseCarTelemetry25(buf) };
    case PacketId.CarStatus:
      return { year: 25, kind: 'carStatus', data: F25.parseCarStatus25(buf) };
    case PacketId.CarDamage:
      return { year: 25, kind: 'carDamage', data: F25.parseCarDamage25(buf) };
    default:
      return null;
  }
}

function dispatch26(id: PacketId, buf: Buffer): ParsedPacket | null {
  switch (id) {
    case PacketId.Motion:
      return { year: 26, kind: 'motion', data: F26.parseMotion26(buf) };
    case PacketId.Session:
      return { year: 26, kind: 'session', data: F26.parseSession26(buf) };
    case PacketId.LapData:
      return { year: 26, kind: 'lapData', data: F26.parseLapData26(buf) };
    case PacketId.Participants:
      return { year: 26, kind: 'participants', data: F26.parseParticipants26(buf) };
    case PacketId.CarTelemetry:
      return { year: 26, kind: 'carTelemetry', data: F26.parseCarTelemetry26(buf) };
    case PacketId.CarStatus:
      return { year: 26, kind: 'carStatus', data: F26.parseCarStatus26(buf) };
    case PacketId.CarDamage:
      return { year: 26, kind: 'carDamage', data: F26.parseCarDamage26(buf) };
    default:
      return null;
  }
}

export type { TelemetryYear };
