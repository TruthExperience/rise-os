import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { syncLeagueRoles } from "@/lib/discord/commands/roles";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled full sync of Discord roles -> pitboss.driver_leagues flags for
 * every league that has role mappings. Triggered by the cron in vercel.json.
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

  const { data: mapped } = await supabase
    .schema("pitboss")
    .from("league_role_map")
    .select("league_id");
  const leagueIds = Array.from(
    new Set(((mapped ?? []) as { league_id: string }[]).map((r) => r.league_id))
  );

  const results: Record<string, unknown>[] = [];

  for (const leagueId of leagueIds) {
    const { data: league } = await supabase
      .schema("rise_os")
      .from("leagues")
      .select("name, discord_server_id")
      .eq("id", leagueId)
      .maybeSingle();

    if (!league?.discord_server_id) {
      results.push({ leagueId, skipped: "no discord_server_id" });
      continue;
    }

    const sync = await syncLeagueRoles(leagueId, league.discord_server_id, true);
    results.push(
      sync.ok
        ? {
            league: league.name,
            changed: sync.changes.length,
            applied: sync.applied,
            failed: sync.failed,
          }
        : { league: league.name, error: sync.error }
    );
  }

  return NextResponse.json({ ok: true, results });
}
