import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/getSupabaseUserId";

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

  // Primary path: the driver linked to this account by discord_id OR user_id
  // (so email sign-ups with a linked driver row work).
  let driverId: string | null = (await getAuthedDriver())?.id ?? null;

  // Fallback for drivers matched only by email on pitboss.drivers. Only
  // trusted once the account's email is confirmed.
  if (!driverId && authUser.email && authUser.email_confirmed_at) {
    const { data } = await admin
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("email", authUser.email)
      .maybeSingle();
    driverId = data?.id ?? null;
  }

  if (!driverId) return NextResponse.json({ hasAccess: false });

  // Owners and head stewards govern the league itself — they shouldn't
  // need to pass a certification exam to access their own steward panel.
  // Only fall through to the licence check for everyone else.
  const { data: membership } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_owner, is_co_owner, is_head_steward")
    .eq("driver_id", driverId)
    .eq("league_id", params.id)
    .maybeSingle();

  if (membership?.is_owner || membership?.is_co_owner || membership?.is_head_steward) {
    return NextResponse.json({ hasAccess: true });
  }

  const { data: licence } = await admin
    .schema("pitboss")
    .from("licences")
    .select("id")
    .eq("driver_id", driverId)
    .eq("league_id", params.id)
    .eq("status", "active")
    .in("role_code", STEWARD_ROLES)
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ hasAccess: !!licence });
}
