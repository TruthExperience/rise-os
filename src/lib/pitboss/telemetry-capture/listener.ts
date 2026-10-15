/**
 * PitBoss — UDP Telemetry Listener
 * ----------------------------------
 * Standalone Node process (NOT for Vercel — needs a persistent socket).
 * Binds a UDP port, feeds every incoming datagram through parser.ts's
 * parsePacket(), and validates size before trusting the decoded output.
 *
 * Nothing in the Next.js app imports this file, so it is never bundled or run
 * by Vercel. It only sits here so its relative imports (./parser, ./header)
 * resolve. Run it on your own machine / VM:
 *
 *   PITBOSS_UDP_PORT=20777 npx tsx src/lib/pitboss/telemetry-capture/listener.ts
 *
 * Works identically whether:
 *   - You're on the same WiFi as the game with UDP Broadcast Mode: On
 *     (packets just show up as normal 'message' events — no special
 *     broadcast handling needed on the receiving side), or
 *   - You're on a remote box (e.g. Oracle VM) with the game's UDP IP
 *     pointed directly at this machine's address (unicast).
 */

import dgram from 'node:dgram';
import { parsePacket, ParsedPacket } from './parser';
import { HEADER_SIZE_BYTES } from './header';

const PORT = Number(process.env.PITBOSS_UDP_PORT ?? 20777);

// ---------------------------------------------------------------------
// Expected packet sizes, for sanity-checking decoded output.
// A buffer that's the wrong length for its declared type didn't
// necessarily throw during decode (Buffer reads only throw on actual
// out-of-bounds access) — it may have silently produced garbage from
// misaligned offsets. Catching a length mismatch here is cheap
// insurance against trusting bad data.
//
// Every figure below is the "bytes total" documented in the matching
// f23.ts / f24.ts / f25.ts / f26.ts struct comment, which each file's
// header says was cross-checked by summing field sizes. If EA changes a
// layout, update the figure here and in the struct file together.
// ---------------------------------------------------------------------
const EXPECTED_SIZES: Partial<Record<number, Partial<Record<ParsedPacket['kind'], number>>>> = {
  23: {
    motion: 1349,
    session: 644,
    lapData: 1131,
    participants: 1306,
    carSetups: 1107,
    carTelemetry: 1352,
    carStatus: 1239,
    carDamage: 953,
  },
  24: {
    motion: 1349,
    session: 753,
    lapData: 1285,
    participants: 1350,
    carSetups: 1133,
    carTelemetry: 1352,
    carStatus: 1239,
    carDamage: 953,
  },
  25: {
    motion: 1349,
    session: 753,
    lapData: 1285,
    participants: 1284,
    carSetups: 1133,
    carTelemetry: 1352,
    carStatus: 1239,
    carDamage: 1041,
  },
  26: {
    motion: 1325,
    session: 926,
    lapData: 1399,
    participants: 1470,
    carSetups: 1233,
    carTelemetry: 1448,
    carStatus: 1445,
    carDamage: 1133,
  },
};

function validateSize(year: number, kind: string, actualLength: number): boolean {
  const expected = EXPECTED_SIZES[year]?.[kind as ParsedPacket['kind']];
  if (expected === undefined) return true; // no known size for this year/kind — skip check
  return actualLength === expected;
}

// ---------------------------------------------------------------------
// Stats — helpful while testing live, to confirm packets are actually
// arriving and see the mix of types coming through.
// ---------------------------------------------------------------------
const stats = {
  received: 0,
  parsed: 0,
  ignored: 0, // recognised-but-uncaptured or unrecognised packetFormat
  malformed: 0, // too short, threw during decode, or failed size validation
  byKind: new Map<string, number>(),
};

function bump(kind: string) {
  stats.byKind.set(kind, (stats.byKind.get(kind) ?? 0) + 1);
}

function printStats() {
  const kindsSummary = [...stats.byKind.entries()]
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  console.log(
    `[listener] received=${stats.received} parsed=${stats.parsed} ` +
    `ignored=${stats.ignored} malformed=${stats.malformed} | ${kindsSummary}`
  );
}

// ---------------------------------------------------------------------
// Socket setup
// ---------------------------------------------------------------------
const socket = dgram.createSocket('udp4');

socket.on('message', (msg: Buffer, rinfo) => {
  stats.received += 1;

  if (msg.length < HEADER_SIZE_BYTES) {
    stats.malformed += 1;
    console.warn(`[listener] datagram too short (${msg.length} bytes) from ${rinfo.address}`);
    return;
  }

  let packet: ParsedPacket | null;
  try {
    packet = parsePacket(msg);
  } catch (err) {
    stats.malformed += 1;
    console.warn('[listener] parsePacket threw', err);
    return;
  }

  if (!packet) {
    stats.ignored += 1;
    return;
  }

  if (!validateSize(packet.year, packet.kind, msg.length)) {
    stats.malformed += 1;
    console.warn(
      `[listener] size mismatch: year=${packet.year} kind=${packet.kind} ` +
      `got=${msg.length} bytes — skipping, not trusting decoded fields`
    );
    return;
  }

  stats.parsed += 1;
  bump(`${packet.year}/${packet.kind}`);

  // ---- Replace this block with real handling once you trust it ----
  // e.g. push to a queue, buffer for batched Supabase writes, relay
  // over WebSocket to the dashboard, etc. Motion/CarTelemetry fire at
  // your configured send rate (up to 60Hz) — don't write every one
  // straight to Supabase.
  if (packet.kind === 'lapData' || packet.kind === 'session') {
    console.log(`[listener] ${packet.year}/${packet.kind} frame=${packet.data.header.frameIdentifier}`);
  }
});

socket.on('error', (err) => {
  console.error('[listener] socket error', err);
});

socket.bind(PORT, () => {
  console.log(`[listener] listening on UDP ${PORT}`);
});

// Print a summary line every 5s so you can see it's alive without
// drowning in per-packet logs during a live test.
const statsInterval = setInterval(printStats, 5000);

process.on('SIGINT', () => {
  clearInterval(statsInterval);
  printStats();
  socket.close(() => {
    console.log('[listener] socket closed, exiting');
    process.exit(0);
  });
});
