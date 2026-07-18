import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pitboss" } }
);

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discordId = (session.user as any).discordId;

  const { data: driver } = await supabaseAdmin
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .single();

  if (!driver) return NextResponse.json({ leagues: [] });

  const { data, error } = await supabaseAdmin
    .from("driver_leagues")
    .select("*, league:league_id(*)")
    .eq("driver_id", driver.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // IncidentsPage.tsx expects { leagues: [...] } with each row shaped as
  // { league_id, role, league: {...} } — driver_leagues already has
  // league_id and role columns, so we just need to wrap the array.
  return NextResponse.json({ leagues: data ?? [] });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discordId = (session.user as any).discordId;
  const { league_id } = await req.json();

  const { data: driver } = await supabaseAdmin
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .single();

  if (!driver) return NextResponse.json({ error: "Driver not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("driver_leagues")
    .insert({ driver_id: driver.id, league_id, role: "driver" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
