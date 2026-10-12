import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
// NOTE: adjust this import to wherever checkin-embed.ts lives in your repo
// (it sits next to checkin.ts in the commands folder).
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  CHECKIN_STATUSES,
  type CheckinStatus,
} from "@/lib/pitboss/discord/commands/checkin-embed";

// Called by pg_cron via pitboss.dispatch_checkin_reminders() every 5
// minutes. Auth is a shared secret (Supabase vault: checkin_reminder_cron_secret),
// NOT a Supabase service-role JWT — this route lives in the app, not
// Supabase, so it doesn't verify Supabase auth.
//
// The Postgres side has already computed which drivers are missing
// (active franchise_rosters minus any round_checkins row for the
// round+division — see dispatch_checkin_reminders for why status is not
// used) and which reminder window fired. This route only has to deliver
// the Discord message, using the same PITBOSS_DISCORD_BOT_TOKEN and
// DISCORD_API_BASE convention as checkin.ts.
//
// Three kinds of payload are handled:
//   dm_reminder       — T-3h, DM each missing driver
//   channel_reminder  — T-1h, ping missing drivers in the division channel
//   race_time_flag    — T-5m, re-render the check-in embed (so the lights /
//                       countdown flip to "formation lap") and ping the
//                       division's check-in role
//
// dispatch_checkin_reminders stamps each *_sent_at column whether or not
// this route succeeds, so race_time_flag always answers 200 and reports
// per-step results in the body instead of failing the whole request.

const DISCORD_API_BASE = "https://discord.com/api/v10";

interface ReminderPayload {
  kind: "dm_reminder" | "channel_reminder" | "race_time_flag";
  post_id: string;
  round_id: string;
  division_id?: string | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  race_time: string;
  driver_discord_ids?: string[];
  role_id?: string | null;
}

function discordHeaders(token: string) {
  return {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
}

async function sendDm(token: string, discordUserId: string, content: string) {
  const dmChannelRes = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
    method: "POST",
    headers: discordHeaders(token),
    body: JSON.stringify({ recipient_id: discordUserId }),
  });

  if (!dmChannelRes.ok) {
    return { discordUserId, ok: false, step: "open_dm", status: dmChannelRes.status };
  }

  const dmChannel = await dmChannelRes.json();

  const sendRes = await fetch(`${DISCORD_API_BASE}/channels/${dmChannel.id}/messages`, {
    method: "POST",
    headers: discordHeaders(token),
    body: JSON.stringify({ content }),
  });

  return { discordUserId, ok: sendRes.ok, step: "send_dm", status: sendRes.status };
}

/**
 * T-5-minute flag. Two independent steps so one failing doesn't block the
 * other: (1) rebuild the check-in embed from live data and PATCH it onto
 * the original message, (2) post a role ping in the division channel.
 */
async function handleRaceTimeFlag(token: string, payload: ReminderPayload) {
  const { post_id, round_id, division_id, discord_channel_id, discord_message_id, role_id } = payload;
  const results: Record<string, unknown> = {};

  // ── Step 1: refresh the embed ────────────────────────────────────
  if (!discord_channel_id || !discord_message_id) {
    results.embed = { ok: false, error: "missing discord_channel_id or discord_message_id" };
  } else if (!division_id) {
    results.embed = { ok: false, error: "missing division_id" };
  } else {
    try {
      const supabase = createAdminClient();

      const [postRes, roundRes, divisionRes, checkinsRes] = await Promise.all([
        supabase
          .schema("pitboss")
          .from("round_checkin_posts")
          .select("id, weather_text, ping_delivery, race_time, track_override, country_override, flag_override")
          .eq("id", post_id)
          .maybeSingle(),
        supabase
          .schema("rise_os")
          .from("calendar_rounds")
          .select("name, round_number, circuit, country, flag_emoji")
          .eq("id", round_id)
          .maybeSingle(),
        supabase
          .schema("rise_os")
          .from("league_divisions")
          .select("division_code")
          .eq("id", division_id)
          .maybeSingle(),
        supabase
          .schema("pitboss")
          .from("round_checkins")
          .select("status, drivers(discord_id)")
          .eq("round_id", round_id)
          .eq("division_id", division_id),
      ]);

      if (postRes.error || !postRes.data) {
        throw new Error(`post lookup failed: ${postRes.error?.message ?? "not found"}`);
      }
      if (roundRes.error || !roundRes.data) {
        throw new Error(`round lookup failed: ${roundRes.error?.message ?? "not found"}`);
      }
      if (divisionRes.error || !divisionRes.data) {
        throw new Error(`division lookup failed: ${divisionRes.error?.message ?? "not found"}`);
      }
      if (checkinsRes.error) {
        throw new Error(`check-in lookup failed: ${checkinsRes.error.message}`);
      }

      const grouped: Partial<Record<CheckinStatus, string[]>> = {};
      for (const row of checkinsRes.data ?? []) {
        const discordId = (row as any).drivers?.discord_id;
        const status = row.status as CheckinStatus;
        if (!discordId || !CHECKIN_STATUSES.includes(status)) continue;
        grouped[status] = grouped[status] ?? [];
        grouped[status]!.push(discordId);
      }

      const embed = buildCheckinEmbed({
        round: roundRes.data,
        divisionCode: divisionRes.data.division_code,
        post: postRes.data,
        grouped,
      });

      const patchRes = await fetch(
        `${DISCORD_API_BASE}/channels/${discord_channel_id}/messages/${discord_message_id}`,
        {
          method: "PATCH",
          headers: discordHeaders(token),
          body: JSON.stringify({
            embeds: [embed],
            components: buildCheckinComponents(post_id),
          }),
        }
      );

      if (!patchRes.ok) {
        const text = await patchRes.text();
        console.error("[checkin-reminders] embed refresh failed:", patchRes.status, text);
        results.embed = { ok: false, status: patchRes.status };
      } else {
        results.embed = { ok: true };
      }
    } catch (err) {
      console.error("[checkin-reminders] race_time_flag embed step threw:", err);
      results.embed = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Step 2: role ping ────────────────────────────────────────────
  if (!discord_channel_id) {
    results.ping = { ok: false, error: "missing discord_channel_id" };
  } else if (!role_id) {
    // League hasn't set league_divisions.discord_checkin_role_id for this
    // division — nothing to ping, not an error.
    results.ping = { ok: false, skipped: "no discord_checkin_role_id set for this division" };
  } else {
    const body: Record<string, unknown> = {
      content: `<@&${role_id}> 🏁 **Race starts in about 5 minutes.** Get to the lobby and be ready on the grid.`,
      allowed_mentions: { roles: [role_id] },
    };
    if (discord_message_id) {
      body.message_reference = { message_id: discord_message_id, fail_if_not_exists: false };
    }

    const pingRes = await fetch(`${DISCORD_API_BASE}/channels/${discord_channel_id}/messages`, {
      method: "POST",
      headers: discordHeaders(token),
      body: JSON.stringify(body),
    });

    if (!pingRes.ok) {
      console.error("[checkin-reminders] role ping failed:", pingRes.status, await pingRes.text());
      results.ping = { ok: false, status: pingRes.status };
    } else {
      results.ping = { ok: true };
    }
  }

  return results;
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.PITBOSS_CHECKIN_REMINDER_CRON_SECRET;
  if (!cronSecret) {
    console.error("[checkin-reminders] PITBOSS_CHECKIN_REMINDER_CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[checkin-reminders] PITBOSS_DISCORD_BOT_TOKEN not set");
    return NextResponse.json({ error: "bot token not configured" }, { status: 500 });
  }

  let payload: ReminderPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { kind, discord_channel_id, discord_message_id, driver_discord_ids, race_time } = payload;

  if (kind === "dm_reminder") {
    const raceTimeLabel = new Date(race_time).toUTCString();
    const content =
      `⏰ **Check-in reminder** — your race starts in about 3 hours (${raceTimeLabel}). ` +
      `Please check in via \`/checkin\` before the deadline.`;

    const results = await Promise.all(
      (driver_discord_ids ?? []).map((id) => sendDm(token, id, content))
    );

    return NextResponse.json({ kind, sent: results.length, results });
  }

  if (kind === "channel_reminder") {
    if (!discord_channel_id) {
      return NextResponse.json({ error: "missing discord_channel_id" }, { status: 400 });
    }

    const mentions = (driver_discord_ids ?? []).map((id) => `<@${id}>`).join(" ");
    const raceTimeLabel = new Date(race_time).toUTCString();
    const content = mentions
      ? `⏰ **Final check-in call** — race starts in about 1 hour (${raceTimeLabel}). ` +
        `Still waiting on: ${mentions}. Check in now via \`/checkin\`.`
      : `⏰ Race starts in about 1 hour (${raceTimeLabel}). All drivers checked in — see you on track!`;

    const body: Record<string, unknown> = { content };
    if (discord_message_id) {
      body.message_reference = { message_id: discord_message_id, fail_if_not_exists: false };
    }

    const res = await fetch(`${DISCORD_API_BASE}/channels/${discord_channel_id}/messages`, {
      method: "POST",
      headers: discordHeaders(token),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error("[checkin-reminders] channel post failed:", res.status, await res.text());
      return NextResponse.json({ error: `channel post failed (${res.status})` }, { status: 502 });
    }

    return NextResponse.json({ kind, ok: true });
  }

  if (kind === "race_time_flag") {
    const results = await handleRaceTimeFlag(token, payload);
    return NextResponse.json({ kind, ...results });
  }

  return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 });
}
