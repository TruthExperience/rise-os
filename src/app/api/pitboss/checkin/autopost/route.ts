// Place at: src/app/api/pitboss/checkin/autopost/route.ts
//
// Called by pg_cron via pitboss.dispatch_checkin_autopost(). The Postgres
// side has already created the round_checkin_posts row (race_time, "Dynamic"
// weather, the division's default pings, autoposted = true). This route only
// delivers the Discord side: it posts the same embed + buttons that
// /checkin-create posts, pings the division's default roles, and saves the
// message id so the reminders and /checkin-create edit-in-place keep working.
//
// Auth: same shared secret as /api/pitboss/checkin/reminders.
// Idempotent: if the post already has a discord_message_id it does nothing.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  fetchLeagueTeamNames,
} from "@/lib/discord/commands/checkin-embed";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.PITBOSS_CHECKIN_REMINDER_CRON_SECRET;
  if (!cronSecret) {
    console.error("[checkin-autopost] PITBOSS_CHECKIN_REMINDER_CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-autopost] PITBOSS_DISCORD_BOT_TOKEN not set");
    return NextResponse.json({ error: "bot token not configured" }, { status: 500 });
  }

  let postId: string | undefined;
  try {
    postId = (await req.json())?.post_id;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!postId) {
    return NextResponse.json({ error: "post_id required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: post, error: postError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .select(
      "id, round_id, division_id, discord_channel_id, discord_message_id, weather_text, ping_delivery, race_time, track_override, country_override, flag_override"
    )
    .eq("id", postId)
    .maybeSingle();

  if (postError || !post) {
    return NextResponse.json({ error: `post lookup failed: ${postError?.message ?? "not found"}` }, { status: 404 });
  }
  if (post.discord_message_id) {
    return NextResponse.json({ ok: true, skipped: "already posted" });
  }

  const [roundRes, divisionRes] = await Promise.all([
    supabase
      .schema("rise_os")
      .from("calendar_rounds")
      .select("name, round_number, circuit, country, flag_emoji, league_id")
      .eq("id", post.round_id)
      .maybeSingle(),
    supabase
      .schema("rise_os")
      .from("league_divisions")
      .select("division_code")
      .eq("id", post.division_id)
      .maybeSingle(),
  ]);

  if (roundRes.error || !roundRes.data) {
    return NextResponse.json({ error: `round lookup failed: ${roundRes.error?.message ?? "not found"}` }, { status: 404 });
  }
  if (divisionRes.error || !divisionRes.data) {
    return NextResponse.json({ error: `division lookup failed: ${divisionRes.error?.message ?? "not found"}` }, { status: 404 });
  }

  const { league_id: leagueId, ...round } = roundRes.data as typeof roundRes.data & { league_id: string };
  const allTeams = leagueId ? await fetchLeagueTeamNames(leagueId) : [];

  const embed = buildCheckinEmbed({
    round,
    divisionCode: divisionRes.data.division_code,
    post,
    grouped: {},
    teams: {},
    allTeams,
  });
  const components = buildCheckinComponents(post.id, post.race_time);

  // Ping the roles listed in the post's ping_delivery (<@&id> mentions).
  const pingText = post.ping_delivery ?? "";
  const roleIds = [...new Set([...pingText.matchAll(/<@&(\d+)>/g)].map((m) => m[1]))];
  const ts = post.race_time ? Math.floor(Date.parse(post.race_time) / 1000) : null;
  const content =
    (roleIds.length > 0 ? `${roleIds.map((r) => `<@&${r}>`).join(" ")}\n` : "") +
    `📋 **Check-in is open** — ${round.name}` +
    (ts ? ` · <t:${ts}:F> (<t:${ts}:R>)` : "") +
    `\nUse the buttons below to respond.`;

  const res = await fetch(`${DISCORD_API_BASE}/channels/${post.discord_channel_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      embeds: [embed],
      components,
      allowed_mentions: { parse: [], roles: roleIds },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[checkin-autopost] channel post failed:", res.status, text);
    // 200 so pg_net doesn't treat it as a transport error; the SQL job retries
    // posts that still have no discord_message_id after 15 minutes.
    return NextResponse.json({ ok: false, status: res.status });
  }

  const posted = await res.json();
  const { error: msgIdError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .update({ discord_message_id: posted.id, updated_at: new Date().toISOString() })
    .eq("id", post.id);

  if (msgIdError) {
    // The message posted fine and its buttons carry the post id, but the
    // stored message id is missing, so a retry would post a duplicate.
    console.error("[checkin-autopost] failed to save discord_message_id:", msgIdError);
    return NextResponse.json({ ok: true, warning: "message posted but id not saved", message_id: posted.id });
  }

  return NextResponse.json({ ok: true, message_id: posted.id });
}
