import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabaseServer";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

export async function GET() {
  const session = await getServerSession(authOptions);

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
  const userId = await getSupabaseUserId(session);
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
