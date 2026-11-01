import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  openDiscordAppealTicket,
  openDiscordIncidentTicket,
} from "@/lib/discord/app-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Self-healing sweep: opens Discord ticket channels for open incidents and
 * appeals that never got one. Triggered by the cron in vercel.json.
 * Vercel sends "Authorization: Bearer $CRON_SECRET".
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient();

  // Only rows older than 2 minutes, so we don't race the normal
  // channel-creation path for brand-new reports.
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const [{ data: incidents }, { data: appeals }] = await Promise.all([
    supabase
      .schema("pitboss")
      .from("incidents")
      .select("id")
      .is("ticket_channel_id", null)
      .in("status", ["open", "under_review"])
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(10),
    supabase
      .schema("pitboss")
      .from("incident_appeals")
      .select("id")
      .is("ticket_channel_id", null)
      .eq("status", "open")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(10),
  ]);

  const results: { kind: string; id: string; result: unknown }[] = [];

  for (const row of incidents ?? []) {
    results.push({
      kind: "incident",
      id: row.id,
      result: await openDiscordIncidentTicket(row.id),
    });
  }
  for (const row of appeals ?? []) {
    results.push({
      kind: "appeal",
      id: row.id,
      result: await openDiscordAppealTicket(row.id),
    });
  }

  return NextResponse.json({ processed: results.length, results });
}
