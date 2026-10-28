import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  fetchTeamLabels,
  groupedDiscordIds,
  CHECKIN_STATUSES,
  type CheckinStatus,
} from "@/lib/discord/commands/checkin-embed";

// Called by pg_cron via pitboss.dispatch_checkin_reminders() every minute.
// Auth is a shared secret (Supabase vault: checkin_reminder_cron_secret),
// NOT a Supabase service-role JWT — this route lives in the app, not
// Supabase, so it doesn't verify Supabase auth.
//
// The Postgres side has already decided which milestone fired and who is
// missing (active franchise_rosters minus any round_checkins row for the
// round+division — see dispatch_checkin_reminders for why status is not
// used). This route only delivers the Discord side, using the same
// PITBOSS_DISCORD_BOT_TOKEN and DISCORD_API_BASE convention as checkin.ts.
//
// One kind per milestone — together they are the five lights:
//   dm_reminder       T-3h   DM each missing driver + ping ALL drivers in channel
//   channel_reminder  T-1h   ping ALL drivers in channel (missing called out)
//   reminder_30m      T-30m  ping ALL drivers in channel (missing called out)
//   lockout           T-15m  re-render embed with buttons disabled + lock notice
//   race_time_flag    T-5m   re-render embed, ping division role + ALL drivers
//   lights_out        T-0    re-render embed (lights go green) + green flag,
//                            pinging the roles selected in the check-in's Pings
//
// Every kind re-renders the check-in embed so the lights row stays in step.
// dispatch_checkin_reminders stamps each *_sent_at column whether or not
// this route succeeds, so this route always answers 200 once the request is
// authenticated and valid, and reports per-step results in the body.

const DISCORD_API_BASE = "https://discord.com/api/v10";

type ReminderKind =
  | "dm_reminder"
  | "channel_reminder"
  | "reminder_30m"
  | "lockout"
  | "race_time_flag"
  | "lights_out";

interface ReminderPayload {
  kind: ReminderKind;
  post_id: string;
  round_id: string;
  division_id?: string | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  race_time: string;
  /** Drivers with no check-in response yet. */
  driver_discord_ids?: string[];
  /** Whole active roster for the round's league + season. */
  all_driver_discord_ids?: string[];
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

/** "<@1> <@2>" capped so the whole message stays under Discord's 2000 chars. */
function mentionString(ids: string[], maxChars = 1300): string {
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < ids.length; i++) {
    const m = `<@${ids[i]}>`;
    if (len + m.length + 1 > maxChars) {
      out.push(`+${ids.length - i} more`);
      break;
    }
    out.push(m);
    len += m.length + 1;
  }
  return out.join(" ");
}

function raceTimestamp(raceTime: string): number {
  return Math.floor(Date.parse(raceTime) / 1000);
}

/**
 * Re-render the check-in embed from live data and PATCH it onto the
 * original message. Buttons come back disabled once check-in is locked
 * (buildCheckinComponents reads the race time). Never throws.
 */
async function refreshEmbed(token: string, payload: ReminderPayload) {
  const { post_id, round_id, division_id, discord_channel_id, discord_message_id } = payload;

  if (!discord_channel_id || !discord_message_id) {
    return { ok: false, error: "missing discord_channel_id or discord_message_id" };
  }
  if (!division_id) {
    return { ok: false, error: "missing division_id" };
  }

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
        .select("status, league_id, drivers(discord_id)")
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

    const leagueId = (checkinsRes.data ?? []).map((r: any) => r.league_id).find(Boolean) as string | undefined;
    const teams = leagueId ? await fetchTeamLabels(leagueId, groupedDiscordIds(grouped)) : {};

    const embed = buildCheckinEmbed({
      round: roundRes.data,
      divisionCode: divisionRes.data.division_code,
      post: postRes.data,
      grouped,
      teams,
    });

    const patchRes = await fetch(
      `${DISCORD_API_BASE}/channels/${discord_channel_id}/messages/${discord_message_id}`,
      {
        method: "PATCH",
        headers: discordHeaders(token),
        body: JSON.stringify({
          embeds: [embed],
          components: buildCheckinComponents(post_id, postRes.data.race_time),
        }),
      }
    );

    if (!patchRes.ok) {
      const text = await patchRes.text();
      console.error("[checkin-reminders] embed refresh failed:", patchRes.status, text);
      return { ok: false, status: patchRes.status };
    }
    return { ok: true };
  } catch (err) {
    console.error("[checkin-reminders] embed refresh threw:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Post a message in the division channel, replying to the check-in post. */
async function postChannelMessage(
  token: string,
  payload: ReminderPayload,
  content: string,
  allowedMentions: Record<string, unknown>
) {
  const { discord_channel_id, discord_message_id } = payload;
  if (!discord_channel_id) {
    return { ok: false, error: "missing discord_channel_id" };
  }

  const body: Record<string, unknown> = { content, allowed_mentions: allowedMentions };
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
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

/**
 * The "ping all drivers" message used at T-3h / T-1h / T-30m / T-5m:
 * a headline, the live race countdown, who hasn't checked in yet, then a
 * mention of every driver on the roster.
 */
function buildDriverPing(headline: string, payload: ReminderPayload, extraLine?: string): string {
  const ts = raceTimestamp(payload.race_time);
  const missing = payload.driver_discord_ids ?? [];
  const all = payload.all_driver_discord_ids ?? [];

  const lines = [`${headline}`, `🕒 <t:${ts}:F> · <t:${ts}:R>`];
  if (extraLine) lines.push(extraLine);
  if (missing.length > 0) {
    lines.push(`❔ **Not checked in yet:** ${mentionString(missing, 450)}`);
  }
  if (all.length > 0) {
    lines.push(`📣 ${mentionString(all, 900)}`);
  }
  return lines.join("\n");
}

/**
 * Who the green flag pings: the roles picked in the check-in's "Pings"
 * field (ping_delivery, set by /checkin-create). Falls back to the
 * division's check-in role, then the roster, so it never goes out silent.
 */
async function resolveGreenFlagPing(payload: ReminderPayload) {
  let pingText = "";
  try {
    const { data } = await createAdminClient()
      .schema("pitboss")
      .from("round_checkin_posts")
      .select("ping_delivery")
      .eq("id", payload.post_id)
      .maybeSingle();
    pingText = (data?.ping_delivery as string | null) ?? "";
  } catch (err) {
    console.error("[checkin-reminders] green flag ping lookup failed:", err);
  }

  const roleIds = [...new Set([...pingText.matchAll(/<@&(\d+)>/g)].map((m) => m[1]))];
  const everyone = /@everyone|@here/.test(pingText);
  const all = payload.all_driver_discord_ids ?? [];

  if (roleIds.length > 0 || everyone) {
    return {
      mentions: [...(everyone ? ["@everyone"] : []), ...roleIds.map((r) => `<@&${r}>`)].join(" "),
      allowedMentions: { parse: everyone ? ["everyone"] : [], roles: roleIds },
    };
  }
  if (payload.role_id) {
    return { mentions: `<@&${payload.role_id}>`, allowedMentions: { parse: [], roles: [payload.role_id] } };
  }
  if (all.length > 0) {
    return { mentions: mentionString(all, 900), allowedMentions: { parse: ["users"] } };
  }
  return { mentions: "", allowedMentions: { parse: [] } };
}

async function handleRaceTimeFlag(token: string, payload: ReminderPayload) {
  const embed = await refreshEmbed(token, payload);

  const all = payload.all_driver_discord_ids ?? [];
  if (!payload.role_id && all.length === 0) {
    return { embed, ping: { ok: false, skipped: "no discord_checkin_role_id and no roster drivers" } };
  }

  const rolePing = payload.role_id ? `<@&${payload.role_id}> ` : "";
  const content =
    rolePing +
    buildDriverPing(
      "🏁 **Race starts in about 5 minutes.** Get to the lobby and be ready on the grid.",
      { ...payload, driver_discord_ids: [] }
    );

  const ping = await postChannelMessage(token, payload, content, {
    parse: ["users"],
    roles: payload.role_id ? [payload.role_id] : [],
  });
  return { embed, ping };
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

  const { kind, race_time, driver_discord_ids } = payload;
  const usersOnly = { parse: ["users"] };

  if (kind === "dm_reminder") {
    // T-3h: DM the drivers who still haven't responded, and ping everyone
    // in the division channel.
    const raceTimeLabel = new Date(race_time).toUTCString();
    const dmContent =
      `⏰ **Check-in reminder** — your race starts in about 3 hours (${raceTimeLabel}). ` +
      `Please check in via \`/checkin\` or the buttons in the check-in channel. ` +
      `Check-in locks 15 minutes before the race.`;

    const [dms, embed, channel] = await Promise.all([
      Promise.all((driver_discord_ids ?? []).map((id) => sendDm(token, id, dmContent))),
      refreshEmbed(token, payload),
      postChannelMessage(
        token,
        payload,
        buildDriverPing(
          "⏰ **3 hours to race.** Check in if you haven't — check-in locks 15 minutes before the start.",
          payload
        ),
        usersOnly
      ),
    ]);

    return NextResponse.json({ kind, dms: { sent: dms.length, results: dms }, embed, channel });
  }

  if (kind === "channel_reminder") {
    // T-1h
    const [embed, channel] = await Promise.all([
      refreshEmbed(token, payload),
      postChannelMessage(
        token,
        payload,
        buildDriverPing(
          "⏰ **1 hour to race.** Final check-in call — check-in locks in 45 minutes.",
          payload
        ),
        usersOnly
      ),
    ]);
    return NextResponse.json({ kind, embed, channel });
  }

  if (kind === "reminder_30m") {
    // T-30m
    const [embed, channel] = await Promise.all([
      refreshEmbed(token, payload),
      postChannelMessage(
        token,
        payload,
        buildDriverPing(
          "⏱️ **30 minutes to race.** Check-in locks in 15 minutes — respond now.",
          payload
        ),
        usersOnly
      ),
    ]);
    return NextResponse.json({ kind, embed, channel });
  }

  if (kind === "lockout") {
    // T-15m: refreshEmbed re-renders with the buttons disabled.
    const embed = await refreshEmbed(token, payload);
    const missing = payload.driver_discord_ids ?? [];
    const content =
      "🔒 **Check-in is now locked.** Responses are closed for this race." +
      (missing.length > 0
        ? `\n❔ **No response:** ${mentionString(missing, 1500)}`
        : "\n✅ Everyone on the roster responded.");
    const channel = await postChannelMessage(token, payload, content, usersOnly);
    return NextResponse.json({ kind, embed, channel });
  }

  if (kind === "race_time_flag") {
    const results = await handleRaceTimeFlag(token, payload);
    return NextResponse.json({ kind, ...results });
  }

  if (kind === "lights_out") {
    // Race time reached: embed lights go green and the green flag waves,
    // pinging the roles selected in the check-in's Pings field.
    const [embed, target] = await Promise.all([
      refreshEmbed(token, payload),
      resolveGreenFlagPing(payload),
    ]);
    const channel = await postChannelMessage(
      token,
      payload,
      `${target.mentions ? `${target.mentions}\n` : ""}🟢🏁 **GREEN FLAG!** Lights out and away we go — the race is underway. Good luck, drivers!`,
      target.allowedMentions
    );
    return NextResponse.json({ kind, embed, channel });
  }

  return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 });
}
