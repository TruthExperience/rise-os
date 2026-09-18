import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

// Without this, Next.js can cache this route's Supabase fetch response
// indefinitely — meaning newly-added leagues (e.g. EFRL) silently don't
// show up on /join until some unrelated deploy happens to invalidate the
// cache. Matches the same class of stale-cache bug already patched
// elsewhere in this app (see the recurring PWA/service-worker caching
// notes) — force this route to always hit the DB fresh.
export const dynamic = "force-dynamic";

export async function GET() {
  const { data: leagues, error } = await supabaseServer
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug, sport, logo_url, season_count, pitboss_status")
    .eq("is_public", true)
    .order("name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let memberships: string[] = [];
  const userId = await getSupabaseUserId();
  if (userId) {
    const { data: rows } = await supabaseServer
      .schema("rise_os")
      .from("league_members")
      .select("league_id")
      .eq("user_id", userId);
    memberships = (rows ?? []).map((r) => r.league_id);
  }

  return NextResponse.json({
    leagues: (leagues ?? []).map((l) => ({
      ...l,
      isMember: memberships.includes(l.id),
    })),
  });
}
