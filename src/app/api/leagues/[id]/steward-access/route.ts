import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

const STEWARD_ROLES = ["STW", "HEAD_STW", "BSAC_CHIEF", "COMMISSIONER", "ADMIN"];

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const authUser = authData?.user;

  if (!authUser) return NextResponse.json({ hasAccess: false });

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("users")
    .select("discord_id, email")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  const discordId = profile?.discord_id ?? undefined;
  const email = profile?.email ?? authUser.email ?? undefined;

  if (!discordId && !email) return NextResponse.json({ hasAccess: false });

  let driver: { id: string } | null = null;

  if (discordId) {
    const { data } = await admin
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("discord_id", discordId)
      .maybeSingle();
    driver = data;
  }

  if (!driver && email) {
    const { data } = await admin
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    driver = data;
  }

  if (!driver) return NextResponse.json({ hasAccess: false });

  // Owners and head stewards govern the league itself — they shouldn't
  // need to pass a certification exam to access their own steward panel.
  // Only fall through to the licence check for everyone else.
  const { data: membership } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_owner, is_co_owner, is_head_steward")
    .eq("driver_id", driver.id)
    .eq("league_id", params.id)
    .maybeSingle();

  if (membership?.is_owner || membership?.is_co_owner || membership?.is_head_steward) {
    return NextResponse.json({ hasAccess: true });
  }

  const { data: licence } = await admin
    .schema("pitboss")
    .from("licences")
    .select("id")
    .eq("driver_id", driver.id)
    .eq("league_id", params.id)
    .eq("status", "active")
    .in("role_code", STEWARD_ROLES)
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ hasAccess: !!licence });
}
