import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

export async function GET(_req: Request, { params }: { params: { leagueId: string } }) {
  const { data, error } = await supabaseAdmin
    .from("franchises")
    .select("*")
    .eq("league_id", params.leagueId)
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: Request, { params }: { params: { leagueId: string } }) {
  const body = await req.json();
  const { name, abbreviation, primary_color, secondary_color } = body;

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .insert({ name, abbreviation, primary_color, secondary_color, league_id: params.leagueId })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
