import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth"; // adjust import path as needed
import { supabaseServer } from "@/lib/supabaseServer";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = await getSupabaseUserId(session);

  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { leagueId } = await req.json();
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .schema("rise_os")
    .rpc("join_league", {
      p_user_id: userId,
      p_league_id: leagueId,
    });

  if (error) {
    // 42501 = league isn't public yet, P0002 = league not found
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ membership: data });
}
