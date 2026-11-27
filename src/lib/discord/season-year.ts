// src/lib/discord/season-year.ts
//
// The season a division label without a year belongs to.
//
// Franchises name their group "F1" while league_divisions names the same group
// "T1 F1 26" (see division-label.ts). The "26" has to come from somewhere, and
// reading the wall clock got it wrong the moment a season outlived its year:
// TRL's season 1 is the "F1 26" season and its divisions keep that code, so a
// clock read would stop matching "F1" to "T1 F1 26" on 1 January 2027.
//
// So the year comes from the season row itself — the one the round belongs to
// when the caller knows it, otherwise the league's active season. A season with
// no start date yet (a division created ahead of its season) borrows the most
// recent season that has one, which keeps a league's scoping stable between
// seasons instead of collapsing to the whole league.

import { createAdminClient } from "@/lib/supabase/server";
import { seasonYearToken } from "./division-label";

type SeasonRow = {
  season_number: number;
  status: string | null;
  start_date: string | null;
};

/**
 * Two-digit season year ("26") for the league's season `seasonNumber`, or for
 * its active season when no number is given. Null when the league has no
 * season to read a year from — callers then treat a year-less label as
 * unplaceable rather than inventing one.
 */
export async function seasonYearFor(
  leagueId: string,
  seasonNumber?: number | string | null
): Promise<string | null> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .schema("rise_os")
      .from("seasons")
      .select("season_number, status, start_date")
      .eq("league_id", leagueId)
      .order("season_number", { ascending: false });

    const seasons = (data ?? []) as SeasonRow[];
    if (seasons.length === 0) return null;

    const wanted = Number(seasonNumber);
    const chosen = Number.isInteger(wanted)
      ? seasons.find((s) => s.season_number === wanted)
      : seasons.find((s) => s.status === "active") ?? seasons[0];

    const yearOf = (row: SeasonRow | undefined) =>
      seasonYearToken(row?.start_date?.slice(0, 4));

    return yearOf(chosen) ?? yearOf(seasons.find((s) => !!s.start_date));
  } catch (err) {
    console.error("[division-label] season year lookup failed:", err);
    return null;
  }
}
