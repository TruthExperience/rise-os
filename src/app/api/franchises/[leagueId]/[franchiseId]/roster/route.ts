import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

export async function GET(
  _req: Request,
  { params }: { params: { leagueId: string; franchiseId: string } }
) {
  const { data, error } = await supabaseAdmin
    .from("players")
    .select(
      "id, name, position, status, ovr, jersey_number, class_year, dev_trait, seasons_played"
    )
    .eq("franchise_id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .order("ovr", { ascending: false, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
