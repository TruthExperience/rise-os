import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSupabaseUserId } from "@/lib/getSupabaseUserId";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = await getSupabaseUserId(session);
  if (!userId) return NextResponse.json({ leagues: [] });

  const { data, error } = await supabaseAdmin
    .from("league_members")
    .select("role, league:league_id(id, name, sport, logo_url)")
    .eq("user_id", userId)
    .eq("status", "active");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leagues = (data ?? [])
    .filter((row: any) => row.league)
    .map((row: any) => ({
      league_id: row.league.id,
      name: row.league.name,
      sport: row.league.sport,
      logo_url: row.league.logo_url,
      role: row.role,
    }));

  return NextResponse.json({ leagues });
}
