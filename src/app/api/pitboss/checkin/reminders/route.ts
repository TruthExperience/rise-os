import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

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

const DISCORD_API_BASE = "https://discord.com/api/v10";

interface ReminderPayload {
  kind: "dm_reminder" | "channel_reminder";
  post_id: string;
  round_id: string;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  race_time: string;
  driver_discord_ids: string[];
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

  return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 });
}
