// app/api/cron/ea-ratings/route.ts
//
// Fetches one team's EA CFB 27 ratings and upserts into Supabase.
// Usage: GET /api/cron/ea-ratings?team=air-force&team_ea_id=1&page=1

import { getSupabaseClient, syncTeam } from "@/lib/ea-ratings";

export const dynamic = "force-dynamic"; // never cache this route

export async function GET(request: Request) {
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
