/**
 * PitBoss — F1 Game Track Reference Data
 * ----------------------------------------------
 * Static reference table of every circuit across F1 23, F1 24, F1 25, and
 * the F1 25: 2026 Season Pack DLC (MADRING). Sourced from EA's official
 * circuit pages and F1Laps' per-game track lists (Aug 2026).
 *
 * Turn counts are the commonly cited nominal figure for each circuit's
 * current FIA-homologated layout — exact counts vary slightly by source
 * depending on how chicanes/kinks are counted, and are NOT guaranteed to
 * match detectCorners()' output frame-for-frame. Use this for sanity
 * checks (e.g. "we detected 8 corners on a 24-corner track — probably
 * missing several") rather than as ground truth to grade against.
 *
 * Layout note: several circuits have changed layout in recent years
 * (Barcelona removed its final chicane in 2023, Marina Bay removed the
 * Turn 16-17 kink in 2023, Yas Marina reconfigured in 2021) — figures
 * below reflect the CURRENT layout as raced from 2023 onward, which is
 * what F1 23/24/25 all use.
 */

export type F1Game = 'f1_23' | 'f1_24' | 'f1_25' | 'f1_25_2026_pack';

export interface TrackInfo {
  /** Stable internal id, e.g. 'bahrain', 'jeddah'. */
  id: string;
  name: string;
  country: string;
  lengthMeters: number;
  /** Nominal turn count for the current layout — see file header caveat. */
  turns: number;
  /** Which games/DLC this circuit (or its reverse layout) appears in. */
  games: F1Game[];
  /** True if this entry is a reversed version of another track's layout. */
  isReverse?: boolean;
  /** True if this circuit is a "classic"/bonus track not on the current F1 calendar. */
  isClassic?: boolean;
}

export const F1_TRACKS: TrackInfo[] = [
  // --- Current F1 calendar circuits (present in F1 23, 24, and 25 alike) ---
  { id: 'bahrain', name: 'Bahrain International Circuit', country: 'Bahrain', lengthMeters: 5412, turns: 15, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'jeddah', name: 'Jeddah Street Circuit', country: 'Saudi Arabia', lengthMeters: 6174, turns: 27, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'melbourne', name: 'Albert Park Circuit', country: 'Australia', lengthMeters: 5278, turns: 14, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'baku', name: 'Baku City Circuit', country: 'Azerbaijan', lengthMeters: 6003, turns: 20, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'miami', name: 'Miami International Autodrome', country: 'United States', lengthMeters: 5412, turns: 19, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'imola', name: 'Autodromo Enzo e Dino Ferrari', country: 'Italy', lengthMeters: 4909, turns: 19, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'monaco', name: 'Circuit de Monaco', country: 'Monaco', lengthMeters: 3337, turns: 19, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'spain', name: 'Circuit de Barcelona-Catalunya', country: 'Spain', lengthMeters: 4657, turns: 14, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'canada', name: 'Circuit Gilles-Villeneuve', country: 'Canada', lengthMeters: 4361, turns: 14, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'austria', name: 'Red Bull Ring', country: 'Austria', lengthMeters: 4318, turns: 10, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'austria_reverse', name: 'Red Bull Ring (Reverse)', country: 'Austria', lengthMeters: 4318, turns: 10, games: ['f1_25', 'f1_25_2026_pack'], isReverse: true },
  { id: 'silverstone', name: 'Silverstone Circuit', country: 'Great Britain', lengthMeters: 5891, turns: 18, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'silverstone_reverse', name: 'Silverstone Circuit (Reverse)', country: 'Great Britain', lengthMeters: 5891, turns: 18, games: ['f1_25', 'f1_25_2026_pack'], isReverse: true },
  { id: 'spa', name: 'Circuit de Spa-Francorchamps', country: 'Belgium', lengthMeters: 7004, turns: 20, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'hungary', name: 'Hungaroring', country: 'Hungary', lengthMeters: 4381, turns: 14, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'netherlands', name: 'Circuit Zandvoort', country: 'Netherlands', lengthMeters: 4259, turns: 14, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'netherlands_reverse', name: 'Circuit Zandvoort (Reverse)', country: 'Netherlands', lengthMeters: 4259, turns: 14, games: ['f1_25', 'f1_25_2026_pack'], isReverse: true },
  { id: 'monza', name: 'Autodromo Nazionale Monza', country: 'Italy', lengthMeters: 5793, turns: 11, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'singapore', name: 'Marina Bay Street Circuit', country: 'Singapore', lengthMeters: 4928, turns: 19, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'japan', name: 'Suzuka International Racing Course', country: 'Japan', lengthMeters: 5807, turns: 18, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'qatar', name: 'Lusail International Circuit', country: 'Qatar', lengthMeters: 5380, turns: 16, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'usa', name: 'Circuit of The Americas', country: 'United States', lengthMeters: 5513, turns: 20, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'mexico', name: 'Autódromo Hermanos Rodríguez', country: 'Mexico', lengthMeters: 4304, turns: 17, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'brazil', name: 'Autódromo José Carlos Pace', country: 'Brazil', lengthMeters: 4309, turns: 15, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'las_vegas', name: 'Las Vegas Strip Circuit', country: 'United States', lengthMeters: 6201, turns: 17, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },
  { id: 'abudhabi', name: 'Yas Marina Circuit', country: 'United Arab Emirates', lengthMeters: 5281, turns: 16, games: ['f1_23', 'f1_24', 'f1_25', 'f1_25_2026_pack'] },

  // --- China: on-calendar for F1 23 and F1 25, absent from F1 24 ---
  { id: 'china', name: 'Shanghai International Circuit', country: 'China', lengthMeters: 5451, turns: 16, games: ['f1_23', 'f1_25', 'f1_25_2026_pack'] },

  // --- Classic/bonus tracks (not on current calendar) ---
  { id: 'portugal', name: 'Autódromo Internacional do Algarve', country: 'Portugal', lengthMeters: 4653, turns: 15, games: ['f1_23', 'f1_24'], isClassic: true },
  { id: 'france', name: 'Circuit Paul Ricard', country: 'France', lengthMeters: 5842, turns: 15, games: ['f1_23', 'f1_24'], isClassic: true },

  // --- F1 25: 2026 Season Pack DLC only ---
  { id: 'madring', name: 'MADRING', country: 'Spain', lengthMeters: 5400, turns: 22, games: ['f1_25_2026_pack'] },
];

const TRACKS_BY_ID = new Map(F1_TRACKS.map((t) => [t.id, t]));

export function getTrackById(id: string): TrackInfo | undefined {
  return TRACKS_BY_ID.get(id);
}

export function getTracksForGame(game: F1Game): TrackInfo[] {
  return F1_TRACKS.filter((t) => t.games.includes(game));
}

export function isTrackAvailableInGame(id: string, game: F1Game): boolean {
  return getTrackById(id)?.games.includes(game) ?? false;
}

/**
 * Loose name matcher for raw_payload.track.name strings coming out of F1
 * UDP telemetry, which don't always match this file's id/name exactly
 * (e.g. "Shanghai" vs "Shanghai International Circuit"). Matches on
 * case-insensitive substring in either direction.
 */
export function findTrackByRawName(rawName: string): TrackInfo | undefined {
  const needle = rawName.trim().toLowerCase();
  if (!needle) return undefined;
  return F1_TRACKS.find(
    (t) => t.name.toLowerCase().includes(needle) || needle.includes(t.id) || t.id.includes(needle)
  );
}
