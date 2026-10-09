// app/api/cron/ea-ratings/route.ts
//
// Fetches one team's EA CFB 27 ratings and upserts into Supabase.
// Usage: GET /api/cron/ea-ratings?team=air-force&team_ea_id=1&page=1

import { getSupabaseClient, syncTeam } from "@/lib/ea-ratings";

export const dynamic = "force-dynamic"; // never cache this route

export async function GET(request: Request) {
  // Same gate as ea-ratings-all: only callers with CRON_SECRET may trigger a sync.
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const teamSlug = searchParams.get("team") ?? "air-force";
  const teamEaId = Number(searchParams.get("team_ea_id") ?? 1);
  const page = Number(searchParams.get("page") ?? 1);

  const supabase = getSupabaseClient();
  const result = await syncTeam(supabase, teamSlug, teamEaId, page);

  if (result.error) {
    console.error(`ea-ratings fetch failed for ${teamSlug}:`, result.error);
    return Response.json(result, { status: 500 });
  }

  return Response.json(result);
}
