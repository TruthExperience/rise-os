import { NextResponse } from "next/server";
import { createClient as createServerClient, createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/supabase-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const driver = await getAuthedDriver();
  if (!driver) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("pitboss")
    .from("drivers")
    .select()
    .eq("id", driver.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST() {
  // getAuthedDriver() returns null until the pitboss.drivers row exists —
  // it can't be used to create it. Resolve public.users directly instead,
  // same linkage the auth callback route uses (user_id -> pitboss.drivers).
  const supabase = await createServerClient();
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const authUserId = claims?.claims?.sub;
  if (claimsError || !authUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("id, discord_id, username, avatar")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (userError || !userRow) {
    return NextResponse.json({ error: "No linked profile for this session" }, { status: 401 });
  }

  const { data, error } = await admin
    .schema("pitboss")
    .from("drivers")
    .upsert(
      {
        user_id: userRow.id,
        discord_id: userRow.discord_id,
        discord_username: userRow.username,
        discord_avatar: userRow.avatar,
      },
      { onConflict: "user_id", ignoreDuplicates: false }
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request) {
  const driver = await getAuthedDriver();
  if (!driver) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { display_name } = body;

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("pitboss")
    .from("drivers")
    .update({ display_name, updated_at: new Date().toISOString() })
    .eq("id", driver.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
