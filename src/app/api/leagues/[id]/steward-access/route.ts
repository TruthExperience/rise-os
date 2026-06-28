import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

const STEWARD_ROLES = ["STW", "HEAD_STW", "BSAC_CHIEF", "COMMISSIONER", "ADMIN"];

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ hasAccess: false });

  const user = session.user as any;

  // Support both field name conventions from next-auth Discord provider
  const discordId: string | undefined =
    user.discordId ?? user.discord_id ?? user.id;

  const email: string | undefined = user.email ?? undefined;

  if (!discordId && !email) return NextResponse.json({ hasAccess: false });

  const supabase = createAdminClient();

  // Look up driver — try discord_id first, fall back to email
  let driver: { id: string } | null = null;

  if (discordId) {
    const { data } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("discord_id", discordId)
      .maybeSingle();
    driver = data;
  }

  if (!driver && email) {
    const { data } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    driver = data;
  }

  if (!driver) return NextResponse.json({ hasAccess: false });

  // Check for active steward-tier licence in this league
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
