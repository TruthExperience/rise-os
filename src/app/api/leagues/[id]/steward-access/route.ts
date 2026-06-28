import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

const STEWARD_ROLES = ["STW", "HEAD_STW", "BSAC_CHIEF", "COMMISSIONER"];

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ hasAccess: false });

  const discordId = (session.user as any).discordId as string;
  if (!discordId) return NextResponse.json({ hasAccess: false });

  const supabase = createAdminClient();

  // Find driver by discord_id directly
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (!driver) return NextResponse.json({ hasAccess: false });

  // Check for active steward licence in this league
  const { data: licence } = await supabase
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
