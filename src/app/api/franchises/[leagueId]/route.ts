import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

const publicAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(_req: Request, { params }: { params: { leagueId: string } }) {
  const { data, error } = await supabaseAdmin
    .from("franchises")
    .select("*")
    .eq("league_id", params.leagueId)
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const gmIds = [...new Set((data ?? []).map((f: any) => f.gm_id).filter(Boolean))];
  let gmMap: Record<string, any> = {};
  if (gmIds.length > 0) {
    const { data: gms } = await publicAdmin
      .from("users")
      .select("id, username, discord_id, avatar")
      .in("id", gmIds);
    gmMap = Object.fromEntries((gms ?? []).map((g: any) => [g.id, g]));
  }

  const enriched = (data ?? []).map((f: any) => ({
    ...f,
    gm: f.gm_id ? gmMap[f.gm_id] ?? null : null,
  }));

  return NextResponse.json(enriched);
}

export async function POST(req: Request, { params }: { params: { leagueId: string } }) {
  const body = await req.json();
  const { name, abbreviation, primary_color, secondary_color } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .insert({ name, abbreviation, primary_color, secondary_color, league_id: params.leagueId })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
