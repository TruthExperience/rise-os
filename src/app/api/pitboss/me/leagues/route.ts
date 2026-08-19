import { getAuthedDriver } from "@/lib/getSupabaseUserId";
import { createAdminClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const authedDriver = await getAuthedDriver();
  if (!authedDriver) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabaseAdmin = createAdminClient().schema("pitboss");

  const { data, error } = await supabaseAdmin
    .from("driver_leagues")
    .select("league_id, role, league:league_id(name, sport, logo_url)")
    .eq("driver_id", authedDriver.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // LeaguePickerPage.tsx expects { leagues: [...] } with each row shaped
  // flat as { league_id, name, sport, logo_url, role } — the join above
  // nests the league row under `league`, so we flatten it here.
  const leagues = (data ?? []).map((row: any) => ({
    league_id: row.league_id,
    role: row.role,
    name: row.league?.name ?? "",
    sport: row.league?.sport ?? "other",
    logo_url: row.league?.logo_url ?? null,
  }));
  return NextResponse.json({ leagues });
}

export async function POST(req: Request) {
  const authedDriver = await getAuthedDriver();
  if (!authedDriver) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabaseAdmin = createAdminClient().schema("pitboss");
  const { league_id } = await req.json();

  const { data, error } = await supabaseAdmin
    .from("driver_leagues")
    .insert({ driver_id: authedDriver.id, league_id, role: "driver" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
