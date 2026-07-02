// app/api/cron/ea-ratings-all/route.ts
//
// Loops every team in rise_os.cfb_teams (that has an ea_team_slug) and
// syncs its ratings page into cfb_players / cfb_player_ratings.
//
// No hardcoded team list — reads directly from your existing cfb_teams
// table, so it stays correct as teams are added/renamed there.
//
// IMPORTANT: set maxDuration high enough in vercel.json for however many
// teams you have times (fetch time + delay). With ~140 FBS teams and a
// 750ms delay between requests, budget for several minutes — see notes
// at the bottom of this file for how to split this into batches if you
// hit the function timeout on your plan.
//
// vercel.json:
//   {
//     "functions": {
//       "app/api/cron/ea-ratings-all/route.ts": { "maxDuration": 300 }
//     },
//     "crons": [{ "path": "/api/cron/ea-ratings-all", "schedule": "0 6 * * *" }]
//   }

import { getSupabaseClient, syncTeam, sleep, TeamSyncResult } from "@/lib/ea-ratings";

export const dynamic = "force-dynamic";

const DELAY_BETWEEN_TEAMS_MS = 750;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Optional: ?conference=Mountain%20West to sync just one conference at a time,
  // useful for staying under maxDuration on smaller Vercel plans.
  const conferenceFilter = searchParams.get("conference");

  const supabase = getSupabaseClient();

  let query = supabase
    .from("cfb_teams")
    .select("team_name, ea_team_id, ea_team_slug, conference")
    .not("ea_team_slug", "is", null)
    .not("ea_team_id", "is", null);

  if (conferenceFilter) {
    query = query.eq("conference", conferenceFilter);
  }

  const { data: teams, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!teams || teams.length === 0) {
    return Response.json({ error: "No teams found with ea_team_slug set." }, { status: 404 });
  }

  const results: TeamSyncResult[] = [];

  for (const team of teams) {
    const result = await syncTeam(
      supabase,
      team.ea_team_slug as string,
      team.ea_team_id as number
    );
    results.push(result);

    if (result.error) {
      console.error(`Failed ${team.team_name} (${team.ea_team_slug}):`, result.error);
    } else {
      console.log(`Synced ${team.team_name}: ${result.playersWritten} players`);
    }

    await sleep(DELAY_BETWEEN_TEAMS_MS);
  }

  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  return Response.json({
    teamsProcessed: results.length,
    teamsSucceeded: succeeded.length,
    teamsFailed: failed.length,
    totalPlayersWritten: succeeded.reduce((sum, r) => sum + r.playersWritten, 0),
    failures: failed, // includes team + error message for each failure
  });
}

// --- Notes on scaling past a single function's maxDuration ---
//
// If ~140 teams * (fetch + 750ms delay) exceeds your plan's max duration
// (Hobby: 60s hard cap; Pro: up to 300s; Enterprise: higher, or use Fluid
// Compute), split the work instead of running it all in one invocation:
//
//   1. Call this route repeatedly with ?conference=X for each conference
//      as separate cron entries (10-ish smaller jobs instead of one giant one), or
//   2. Swap the for-loop for a queue (Vercel Queues / QStash) that fans out
//      one message per team, each handled by the single-team route above.
