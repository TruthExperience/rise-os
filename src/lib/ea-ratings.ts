// lib/ea-ratings.ts
//
// Shared logic for fetching EA SPORTS College Football 27 team ratings
// pages and upserting them into rise_os.cfb_players / cfb_player_ratings.
//
// Used by both:
//   app/api/cron/ea-ratings/route.ts       (single team, on demand)
//   app/api/cron/ea-ratings-all/route.ts   (loops every team in cfb_teams)

import { createClient } from "@supabase/supabase-js";

const BASE_URL =
  "https://www.ea.com/games/ea-sports-college-football/ratings/teams-ratings";

export const GAME = "CFB27";
export const ROSTER_VERSION = "preseason"; // update once season goes live
export const DATA_SOURCE = "ea_ratings_page"; // distinct from existing 'ea_datamine' rows

// EA's camelCase stat keys -> rise_os.cfb_player_ratings snake_case columns.
// Only keys with a mapping are written; EA fields with no match
// (breakSack, runningStyle) are ignored.
const STAT_KEY_MAP: Record<string, string> = {
  overall: "overall",
  speed: "speed",
  acceleration: "acceleration",
  strength: "strength",
  agility: "agility",
  awareness: "awareness",
  jumping: "jumping",
  injury: "injury",
  stamina: "stamina",
  toughness: "toughness",
  changeOfDirection: "change_of_direction",
  catching: "catching",
  spectacularCatch: "spectacular_catch",
  catchInTraffic: "catch_in_traffic",
  shortRouteRunning: "short_route_running",
  mediumRouteRunning: "medium_route_running",
  deepRouteRunning: "deep_route_running",
  carrying: "carrying",
  breakTackle: "break_tackle",
  trucking: "trucking",
  bCVision: "bc_vision",
  stiffArm: "stiff_arm",
  spinMove: "spin_move",
  jukeMove: "juke_move",
  throwPower: "throw_power",
  throwUnderPressure: "throw_under_pressure",
  throwAccuracyShort: "throw_accuracy_short",
  throwAccuracyMid: "throw_accuracy_mid",
  throwAccuracyDeep: "throw_accuracy_deep",
  throwOnTheRun: "throw_on_the_run",
  playAction: "play_action",
  tackle: "tackle",
  powerMoves: "power_moves",
  finesseMoves: "finesse_moves",
  blockShedding: "block_shedding",
  pursuit: "pursuit",
  playRecognition: "play_recognition",
  manCoverage: "man_coverage",
  zoneCoverage: "zone_coverage",
  hitPower: "hit_power",
  press: "press",
  runBlock: "run_block",
  passBlock: "pass_block",
  impactBlocking: "impact_blocking",
  runBlockPower: "run_block_power",
  runBlockFinesse: "run_block_finesse",
  passBlockPower: "pass_block_power",
  passBlockFinesse: "pass_block_finesse",
  leadBlock: "lead_block",
  kickPower: "kick_power",
  kickAccuracy: "kick_accuracy",
  kickReturn: "kick_return",
};

interface EaStat {
  value: number;
  diff: number;
}

interface EaPlayer {
  id: number;
  avatarUrl: string;
  firstName: string;
  lastName: string;
  height: number;
  weight: number;
  overallRating: number;
  homeTown: string;
  homeState: string;
  redShirtStatus: string;
  jerseyNum: number;
  schoolYear: string;
  conference: string;
  team: string;
  position: string;
  stats: Record<string, EaStat>;
}

export interface TeamRatingsResult {
  players: EaPlayer[];
  totalItems: number;
}

export interface TeamSyncResult {
  team: string;
  teamEaId: number;
  page: number;
  totalItems: number;
  playersWritten: number;
  error?: string;
}

/** Create a Supabase client scoped to the rise_os schema, using the service role key. */
export function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }

  return createClient(url, key, { db: { schema: "rise_os" } });
}

// Derived from the actual call above, so it's correctly typed for the
// "rise_os" schema instead of defaulting to the plain "public" schema
// that the bare SupabaseClient type assumes.
export type RiseOsClient = ReturnType<typeof getSupabaseClient>;

/** Fetch one team's ratings page and pull the ratingsEntries payload out of __NEXT_DATA__. */
export async function fetchTeamRatings(
  teamSlug: string,
  page = 1
): Promise<TeamRatingsResult> {
  const url = `${BASE_URL}/${teamSlug}/${page}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s
  );

  if (!match) {
    throw new Error(
      `Could not find __NEXT_DATA__ for ${teamSlug} — page structure changed or request was blocked.`
    );
  }

  const data = JSON.parse(match[1]);
  const pageProps = data?.props?.pageProps ?? {};

  return {
    players: pageProps.ratingsEntries?.items ?? [],
    totalItems: pageProps.ratingsEntries?.totalItems ?? 0,
  };
}

/** Map an EA player record into rise_os.cfb_players + cfb_player_ratings row shapes. */
function toDbRows(p: EaPlayer, teamEaId: number) {
  const playerRow = {
    ea_player_id: p.id,
    ea_slug: `${p.firstName}-${p.lastName}`.toLowerCase().replace(/\s+/g, "-"),
    name: `${p.firstName} ${p.lastName}`,
    position: p.position,
    team: p.team,
    team_ea_id: teamEaId,
    conference: p.conference,
    height: p.height ? String(p.height) : null,
    weight: p.weight ?? null,
    jersey_number: p.jerseyNum ?? null,
    school_year: p.schoolYear ?? null,
    hometown:
      p.homeTown && p.homeState ? `${p.homeTown}, ${p.homeState}` : p.homeTown ?? null,
    data_source: DATA_SOURCE,
    updated_at: new Date().toISOString(),
  };

  const ratingRow: Record<string, unknown> = {
    ea_player_id: p.id,
    game: GAME,
    roster_version: ROSTER_VERSION,
    overall: p.overallRating,
    scraped_at: new Date().toISOString(),
  };

  for (const [eaKey, dbCol] of Object.entries(STAT_KEY_MAP)) {
    const stat = p.stats?.[eaKey];
    if (stat) ratingRow[dbCol] = stat.value;
  }

  return { playerRow, ratingRow };
}

/** Fetch one team's ratings and upsert into Supabase. Returns a summary, never throws. */
export async function syncTeam(
  supabase: RiseOsClient,
  teamSlug: string,
  teamEaId: number,
  page = 1
): Promise<TeamSyncResult> {
  try {
    const { players, totalItems } = await fetchTeamRatings(teamSlug, page);

    const playerRows = [];
    const ratingRows = [];

    for (const p of players) {
      const { playerRow, ratingRow } = toDbRows(p, teamEaId);
      playerRows.push(playerRow);
      ratingRows.push(ratingRow);
    }

    if (playerRows.length === 0) {
      return { team: teamSlug, teamEaId, page, totalItems, playersWritten: 0 };
    }

    // 1. Upsert players first (ratings has an FK on ea_player_id)
    const { error: playersError } = await supabase
      .from("cfb_players")
      .upsert(playerRows, { onConflict: "ea_player_id" });

    if (playersError) throw playersError;

    // 2. Upsert ratings, keyed on the actual unique constraint:
    //    cfb_player_ratings_ea_player_id_game_roster_version_key
    const { error: ratingsError } = await supabase
      .from("cfb_player_ratings")
      .upsert(ratingRows, { onConflict: "ea_player_id,game,roster_version" });

    if (ratingsError) throw ratingsError;

    return {
      team: teamSlug,
      teamEaId,
      page,
      totalItems,
      playersWritten: playerRows.length,
    };
  } catch (err) {
    return {
      team: teamSlug,
      teamEaId,
      page,
      totalItems: 0,
      playersWritten: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Simple sleep helper for pacing requests between teams. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
