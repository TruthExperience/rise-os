import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

const STEWARD_ROLES = ["STW", "HEAD_STW", "BSAC_CHIEF"];

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ hasAccess: false });

  const supabase = createAdminClient(); // was: await createClient()

  const { data: user } = await supabase
    .from("users")
    .select("discord_id")
    .eq("id", session.user.id)
    .single();

  if (!user?.discord_id) return NextResponse.json({ hasAccess: false });

  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", user.discord_id)
    .single();

  if (!driver) return NextResponse.json({ hasAccess: false });

  const { data: licence } = await supabase
    .schema("pitboss")
    .from("licences")
    .select("id")
    .eq("driver_id", driver.id)
    .eq("league_id", params.id)
    .eq("status", "active")
    .in("role_code", STEWARD_ROLES)
    .limit(1)
    .single();

  return NextResponse.json({ hasAccess: !!licence });
}
