// FILE: src/app/api/pitboss/standings-backfill/route.ts   (new file)
// One-off: posts a pinned drivers + teams standings card for every round
// already in the database (oldest first). Gate: Authorization: Bearer CRON_SECRET.
// Usage: GET /api/pitboss/standings-backfill?league_id=<uuid>
import { backfillStandingsToDiscord } from "@/lib/discord/standings-post";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const leagueId = new URL(request.url).searchParams.get("league_id");
  if (!leagueId) return Response.json({ error: "league_id required" }, { status: 400 });
  const rounds = await backfillStandingsToDiscord(leagueId);
  return Response.json({ ok: true, rounds });
}
