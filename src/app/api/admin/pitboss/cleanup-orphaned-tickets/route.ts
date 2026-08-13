// src/app/api/admin/pitboss/cleanup-orphaned-tickets/route.ts
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { deleteTicketChannel } from "@/lib/discord/tickets";

/**
 * One-time-use cleanup: finds Discord ticket channels sitting under a
 * league's configured ticket category that no longer correspond to any
 * incident or appeal row in the DB, and deletes them.
 *
 * "Valid" = the channel ID appears as ticket_channel_id on some row in
 * pitboss.incidents or pitboss.incident_appeals, in ANY status — not
 * just open ones. A closed-but-not-yet-/steward-deleted ticket still
 * has a real incident behind it and must be left alone; only channels
 * with no matching row at all (e.g. the 22 incidents wiped from the DB
 * on Aug 13 2026) count as orphaned.
 *
 * Also explicitly protects the league's other configured channels
 * (incident/appeals/transcript log channels) in case any of those
 * happen to live under the same category ID.
 *
 * Visit this URL once, review the response, then DELETE THIS FILE.
 */
export async function GET() {
  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "PITBOSS_DISCORD_BOT_TOKEN not set" },
      { status: 500 }
    );
  }

  const supabase = createAdminClient();

  const { data: leagues, error: leaguesError } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select(
      "id, name, discord_server_id, discord_ticket_category_id, discord_incident_channel_id, discord_appeals_channel_id, discord_transcript_channel_id"
    )
    .not("discord_server_id", "is", null)
    .not("discord_ticket_category_id", "is", null);

  if (leaguesError || !leagues) {
    return NextResponse.json(
      { error: `League query failed: ${leaguesError?.message ?? "unknown"}` },
      { status: 500 }
    );
  }

  const results: Array<{
    league: string;
    leagueId: string;
    scanned: number;
    deleted: string[];
    deleteFailures: string[];
    kept: number;
  }> = [];

  for (const league of leagues) {
    const guildId = league.discord_server_id as string;
    const categoryId = league.discord_ticket_category_id as string;

    // Every channel ID currently referenced by a real DB row for this
    // league, regardless of incident/appeal status.
    const [{ data: incidentChannels }, { data: appealChannels }] =
      await Promise.all([
        supabase
          .schema("pitboss")
          .from("incidents")
          .select("ticket_channel_id")
          .eq("league_id", league.id)
          .not("ticket_channel_id", "is", null),
        supabase
          .schema("pitboss")
          .from("incident_appeals")
          .select("ticket_channel_id")
          .eq("league_id", league.id)
          .not("ticket_channel_id", "is", null),
      ]);

    const validChannelIds = new Set<string>([
      ...(incidentChannels ?? []).map((r) => r.ticket_channel_id as string),
      ...(appealChannels ?? []).map((r) => r.ticket_channel_id as string),
      ...[
        league.discord_incident_channel_id,
        league.discord_appeals_channel_id,
        league.discord_transcript_channel_id,
      ].filter((id): id is string => !!id),
    ]);

    const channelsRes = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/channels`,
      { headers: { Authorization: `Bot ${token}` } }
    );

    if (!channelsRes.ok) {
      results.push({
        league: league.name ?? league.id,
        leagueId: league.id,
        scanned: 0,
        deleted: [],
        deleteFailures: [`channel list fetch failed: ${channelsRes.status}`],
        kept: 0,
      });
      continue;
    }

    const allChannels: any[] = await channelsRes.json();
    const ticketChannels = allChannels.filter(
      (c) => c.type === 0 && c.parent_id === categoryId
    );

    const deleted: string[] = [];
    const deleteFailures: string[] = [];
    let kept = 0;

    for (const channel of ticketChannels) {
      if (validChannelIds.has(channel.id)) {
        kept++;
        continue;
      }
      // Only touch channels that match the bot's own naming convention,
      // as a safety net against deleting something a human created
      // manually in the ticket category for unrelated reasons.
      if (!/^(incident|appeal)-/.test(channel.name ?? "")) {
        kept++;
        continue;
      }

      const ok = await deleteTicketChannel(channel.id);
      if (ok) {
        deleted.push(`${channel.name} (${channel.id})`);
      } else {
        deleteFailures.push(`${channel.name} (${channel.id})`);
      }
    }

    results.push({
      league: league.name ?? league.id,
      leagueId: league.id,
      scanned: ticketChannels.length,
      deleted,
      deleteFailures,
      kept,
    });
  }

  return NextResponse.json({ results });
}
