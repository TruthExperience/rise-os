import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

// NOTE: this route previously authenticated via next-auth
// (getServerSession(authOptions) + session.user.discordId), which is a
// different auth system than the rest of the app now uses. The app has
// moved to Supabase Auth — see getAuthedDriver() in supabase-auth.ts,
// which resolves the current session via supabase.auth.getClaims() ->
// public.users.auth_user_id -> public.users.id -> pitboss.drivers.user_id.
// Because next-auth's session is no longer being populated the same way,
// getServerSession(authOptions) was returning null on every request here,
// causing this route to 401 unconditionally regardless of whether the
// caller had a valid (Supabase) session. Downstream pages that depend on
// this endpoint to resolve "my leagues" (Appeals, Season Calendar) were
// failing as a result. Switched to getAuthedDriver() to match the rest of
// the app's auth model.

export const dynamic = "force-dynamic";

export async function GET() {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("*, league:league_id(*)")
    .eq("driver_id", driver.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { league_id } = await req.json();

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .insert({ driver_id: driver.id, league_id, role: "driver" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
