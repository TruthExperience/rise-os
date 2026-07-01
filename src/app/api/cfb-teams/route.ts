import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

// Returns all CFB27 team ratings. Used by the franchise pages to
// display each real-world team's Off/Def/OVR next to a user's franchise.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("cfb_teams")
    .select("id, team_name, nickname, conference, ovr, offense_ovr, defense_ovr, logo_url")
    .eq("game_version", "CFB27")
    .order("team_name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
