import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { autoProvisionGuild } from "@/lib/pitboss/autoProvisionGuild";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled auto-map + full sync of Discord roles -> pitboss.driver_leagues flags for
 * every league linked to a Discord server. Triggered by the cron in vercel.json.
 * Vercel sends "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set
 * in the project's environment variables.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient() as any;

  // Every league linked to a Discord server -- not just ones with mappings --
  // so new roles are picked up and mapped automatically.
  const { data: leagues } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, discord_server_id")
    .not("discord_server_id", "is", null);

  const results: Record<string, unknown>[] = [];

  for (const league of (leagues ?? []) as { id: string; name: string; discord_server_id: string }[]) {
    const r = await autoProvisionGuild({
      guildId: league.discord_server_id,
      leagueId: league.id,
      force: true,
    });
    results.push({
      league: league.name,
      ok: r.ok,
      error: r.error,
      newMappings: r.mappedRoles?.length ?? 0,
      members: r.members,
    });
  }

  return NextResponse.json({ ok: true, results });
}
