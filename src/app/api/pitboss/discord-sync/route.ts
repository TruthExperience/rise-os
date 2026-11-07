// Place at: src/app/api/pitboss/discord-sync/route.ts
//
// Called by pg_cron via pitboss.dispatch_discord_results_sync(). Statement-level
// triggers on pitboss.results mark (league, season, round) in
// pitboss.discord_sync_dirty whenever results are inserted, edited or deleted
// -- including direct DB edits that never go through the app. This route drains
// that queue: it edits each round's race/quali posts, then refreshes the driver
// and team standings posts. Rows are only deleted after the Discord work ran,
// and only if they haven't been re-marked meanwhile, so nothing is lost.
//
// Auth: same shared secret as /api/pitboss/checkin/autopost.
// Idempotent: an empty queue does nothing.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  postRoundResultsToDiscord,
  syncStandingsToDiscord,
} from "@/lib/discord/standings-post";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 100;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.PITBOSS_CHECKIN_REMINDER_CRON_SECRET;
  if (!cronSecret) {
    console.error("[discord-sync] PITBOSS_CHECKIN_REMINDER_CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const pb = supabase.schema("pitboss");

  const { data: dirty, error } = await pb
    .from("discord_sync_dirty")
    .select("league_id, season, round, marked_at")
    .order("marked_at", { ascending: true })
    .limit(MAX_ROWS);
  if (error) {
    console.error("[discord-sync] queue read failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!dirty || dirty.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // Standings tables are rebuilt by DB triggers, but recompute once more so
  // the Discord cards always read a fresh rollup.
  const rc = await pb.rpc("recompute_driver_standings");
  if (rc.error) {
    console.error("[discord-sync] standings recompute failed:", rc.error.message);
  }

  const leagues = [...new Set(dirty.map((d: any) => d.league_id as string))];
  let rounds = 0;

  for (const leagueId of leagues) {
    const rows = dirty.filter((d: any) => d.league_id === leagueId);
    for (const r of rows) {
      await postRoundResultsToDiscord(leagueId, r.season, r.round);
      rounds++;
    }
    // Results can change in place without row_count/created_at moving, so the
    // normal version check would skip the standings post: force it.
    await syncStandingsToDiscord(leagueId, { force: true });
  }

  // Clear only what we handled; a row re-marked since we read it stays queued.
  for (const r of dirty) {
    const { error: delErr } = await pb
      .from("discord_sync_dirty")
      .delete()
      .eq("league_id", r.league_id)
      .eq("season", r.season)
      .eq("round", r.round)
      .lte("marked_at", r.marked_at);
    if (delErr) {
      console.error("[discord-sync] queue cleanup failed:", delErr.message);
    }
  }

  return NextResponse.json({ ok: true, processed: dirty.length, rounds, leagues: leagues.length });
}
