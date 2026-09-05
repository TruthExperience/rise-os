import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  roundLabel,
  CHECKIN_STATUSES,
  type CheckinStatus,
} from "./checkin-embed";

// Tables now confirmed against live schema:
//   rise_os.calendar_rounds    (was guessed as pitboss.race_rounds)
//   pitboss.round_checkins     (was guessed as pitboss.race_checkins)
//   pitboss.round_grid_entries (was guessed as pitboss.race_grids)
//   rise_os.league_divisions   (new — added for per-division check-in channels)
//   pitboss.round_checkin_posts (new — tracks the posted embed per round+division)
//
// round_checkins.status CHECK extended to also allow 'healer' and 'damage'
// (matching the Discord button labels), on top of the original
// confirmed/tentative/declined/no_response. round_checkins also gained a
// division_id column (FK -> rise_os.league_divisions) so a response is
// scoped to D1 or D2.
//
// division_id now exists on calendar_rounds too, and D1/D2 rows reuse the
// same round_number (e.g. two separate "round 5" rows with different
// race_date/circuit). Any resolveRound() call that doesn't pass a
// divisionId is ambiguous once both divisions have rows for that round —
// every command below resolves a division first and threads it through.
//
// PATCH (2026-09-03): franchise_rosters (pitboss schema) and franchises
// (rise_os schema) live in different exposed PostgREST schemas.
// PostgREST's multi-schema (db-schemas) support builds relationship
// visibility per exposed schema rather than as one merged graph, so
// resource-embedding shorthand across schemas (`franchises(name)`) fails
// with "could not find a relationship in the schema cache" even though
// the FK (franchise_rosters_franchise_id_fkey -> rise_os.franchises.id)
// is completely valid at the Postgres level, and regardless of schema
// cache freshness. generate-grid now fetches franchise_rosters and
// franchises as two separate queries and joins them client-side. Do not
// reintroduce an embedded `franchises(...)` select on franchise_rosters.
//
// PATCH (2026-09-04): round_checkin_posts gained track_override /
// country_override / flag_override (all nullable text) so /checkin-create
// can post a check-in with a manually-typed track instead of only ever
// trusting calendar_rounds.circuit/country/flag_emoji. Used for late venue
// swaps or rounds where the calendar row hasn't been fixed yet. See
// buildCheckinEmbed in checkin-embed.ts for the override precedence.
//
// PATCH (2026-09-04 cont'd): round_checkin_posts also gained
// dm_reminder_sent_at / channel_reminder_sent_at, populated by the
// pg_cron-driven pitboss.dispatch_checkin_reminders() function (3hr DM
// ping / 1hr channel ping, delivered via
// src/app/api/pitboss/checkin/reminders/route.ts). checkin-create now
// resets both stamps to null whenever race_time actually changes on a
// re-run (e.g. a reschedule), so the automated reminders fire again
// against the new time instead of staying silently "already sent".
//
// PATCH (2026-09-04 cont'd 2): ctx.leagueId is optional (CommandContext),
// so every handler below resolves it into a narrowed `leagueId` local up
// front and bails with a friendly error if it's missing, instead of
// passing the optional value straight into functions that expect a
// required string. Same pattern used in cap.ts — see notes there for why
// the earlier non-null-assertion / optional-chaining attempts got reverted.
//
// PATCH (2026-09-04 cont'd 3): ctx.channelId is also optional on
// CommandContext (same refactor as leagueId above), so every call site
// that resolves a division by channel now narrows it into a local
// `channelId` up front and bails with a friendly error if it's missing,
// rather than passing the optional value straight into
// resolveDivisionByChannel (which requires a plain string). Fixes a
// build-time type error at the call sites in checkin, checkin-status,
// checkin-remind, and generate-grid.

const ADMIN_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
  "is_head_steward",
  "is_steward",
] as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

export async function getOrCreateDriver(
  discordId: string,
  resolvedUsername: string | undefined
) {
  const supabase = createAdminClient();
  let { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (!driver) {
    const { data: created, error } = await supabase
      .schema("pitboss")
      .from("drivers")
      .insert({ discord_id: discordId, discord_username: resolvedUsername ?? discordId })
      .select("id")
      .single();
    if (error || !created) {
      return { error: error?.message ?? "unknown error creating driver" } as const;
    }
    driver = created;
  }
  return { driver } as const;
}

/**
 * Resolves a round from a free-text `round` option (matched against
 * round_number if numeric, else name), or falls back to the next
 * upcoming round for the league/season if none was given.
 *
 * Pass `divisionId` whenever it's known — D1 and D2 rows share
 * round_number values (and can share names/dates ranges), so an
 * unscoped lookup can silently return the wrong division's round once
 * both divisions have calendars loaded. `divisionId` is optional only
 * to support leagues that haven't set up divisions at all.
 *
 * NOTE: calendar_rounds lives in the rise_os schema, not pitboss.
 */
export async function resolveRound(
  leagueId: string,
  roundInput: string | undefined,
  seasonInput: string | undefined,
  divisionId?: string
) {
  const supabase = createAdminClient();
  let query = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("id, season_number, round_number, name, race_date, circuit, country, flag_emoji, division_id")
    .eq("league_id", leagueId);

  if (divisionId) {
    query = query.eq("division_id", divisionId);
  }

  if (seasonInput) {
    const seasonNum = Number(seasonInput);
    query = Number.isFinite(seasonNum)
      ? query.eq("season_number", seasonNum)
      : query; // ignore malformed season input rather than erroring silently
  }

  if (roundInput) {
    const asNumber = Number(roundInput);
    query = Number.isFinite(asNumber)
      ? query.eq("round_number", asNumber)
      : query.ilike("name", `%${roundInput}%`);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) return { error: error.message } as const;
    if (!data) return { error: `No round matching "${roundInput}" found.` } as const;
    return { round: data } as const;
  }

  const { data, error } = await query
    .gte("race_date", new Date().toISOString())
    .order("race_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return { error: error.message } as const;
  if (!data) return { error: "No upcoming round scheduled — specify one with `round`." } as const;
  return { round: data } as const;
}

/**
 * Resolves a division (D1/D2/etc.) for the league, case-insensitively,
 * from an explicit division code. Used by admin commands (checkin-create)
 * where the invoking channel isn't necessarily the division's own channel.
 * A league with no rows in league_divisions has no per-division
 * check-in channels set up yet — surfaced as an error rather than a
 * silent fallback.
 */
async function resolveDivision(leagueId: string, divisionInput: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("id, division_code, discord_checkin_channel_id")
    .eq("league_id", leagueId)
    .ilike("division_code", divisionInput)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) return { error: `No division "${divisionInput}" set up for this league.` } as const;
  if (!data.discord_checkin_channel_id) {
    return { error: `Division ${data.division_code} has no check-in channel configured.` } as const;
  }
  return { division: data } as const;
}

/**
 * Resolves a division by matching the invoking channel against
 * league_divisions.discord_checkin_channel_id. Used by the
 * driver/general-purpose commands (checkin, checkin-status,
 * checkin-remind, generate-grid), which don't take a division option —
 * running them in a division's check-in channel is what scopes them.
 * Returns an error if the channel isn't registered to any division,
 * rather than falling back to an ambiguous league-wide lookup.
 */
async function resolveDivisionByChannel(leagueId: string, channelId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("id, division_code, discord_checkin_channel_id")
    .eq("league_id", leagueId)
    .eq("discord_checkin_channel_id", channelId)
    .maybeSingle();

  if (error) return { error: error.message } as const;
  if (!data) {
    return {
      error: "This command needs to be run in a division's check-in channel — couldn't match this channel to a division.",
    } as const;
  }
  return { division: data } as const;
}

/**
 * Pulls every response for a round+division, grouped by status, as
 * discord_id arrays — the shape buildCheckinEmbed expects.
 */
async function fetchGroupedCheckins(roundId: string, divisionId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("status, drivers(discord_id)")
    .eq("round_id", roundId)
    .eq("division_id", divisionId);

  if (error) return { error: error.message } as const;

  const grouped: Partial<Record<CheckinStatus, string[]>> = {};
  for (const row of data ?? []) {
    const discordId = (row as any).drivers?.discord_id;
    const status = row.status as CheckinStatus;
    if (!discordId || !CHECKIN_STATUSES.includes(status)) continue;
    grouped[status] = grouped[status] ?? [];
    grouped[status]!.push(discordId);
  }
  return { grouped } as const;
}

registerCommand("checkin", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const channelId = ctx.channelId;
  if (!channelId) {
    return { content: "This command must be used in a division's check-in channel.", ephemeral: true };
  }

  const status = ctx.options.status as CheckinStatus;
  if (!status) {
    return { content: "status is required.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(leagueId, channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    leagueId,
    ctx.options.round as string | undefined,
    ctx.options.season as string | undefined,
    division.id
  );
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const driverResult = await getOrCreateDriver(ctx.discordUserId, ctx.resolvedUsers[ctx.discordUserId]?.username);
  if ("error" in driverResult) {
    return { content: `Couldn't resolve your driver record: ${driverResult.error}`, ephemeral: true };
  }

  const supabase = createAdminClient();
  const { error: upsertError } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .upsert(
      {
        round_id: round.id,
        division_id: division.id,
        driver_id: driverResult.driver.id,
        league_id: leagueId,
        status,
        checked_in_at: new Date().toISOString(),
      },
      { onConflict: "round_id,driver_id" }
    );

  if (upsertError) {
    console.error("[checkin] upsert failed:", upsertError);
    return { content: `Something went wrong saving your check-in: ${upsertError.message}`, ephemeral: true };
  }

  return { content: `Checked in as **${status}** for ${roundLabel(round)}.`, ephemeral: true };
});

registerCommand("checkin-status", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const channelId = ctx.channelId;
  if (!channelId) {
    return { content: "This command must be used in a division's check-in channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to view check-in status.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(leagueId, channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    leagueId,
    ctx.options.round as string | undefined,
    ctx.options.season as string | undefined,
    division.id
  );
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const supabase = createAdminClient();
  const { data: checkins, error } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("status, driver_id, drivers(discord_id)")
    .eq("round_id", round.id)
    .eq("division_id", division.id);

  if (error) {
    console.error("[checkin-status] lookup failed:", error);
    return { content: `Something went wrong pulling check-ins: ${error.message}`, ephemeral: true };
  }

  const byStatus: Record<CheckinStatus, string[]> = {
    confirmed: [],
    tentative: [],
    declined: [],
    healer: [],
    damage: [],
  };
  for (const row of checkins ?? []) {
    const discordId = (row as any).drivers?.discord_id;
    if (discordId && row.status in byStatus) {
      byStatus[row.status as CheckinStatus].push(`<@${discordId}>`);
    }
  }

  const lines = [
    `**Check-in status — ${roundLabel(round)} — Division ${division.division_code}**`,
    `Confirmed (${byStatus.confirmed.length}): ${byStatus.confirmed.join(", ") || "none"}`,
    `Tentative (${byStatus.tentative.length}): ${byStatus.tentative.join(", ") || "none"}`,
    `Declined (${byStatus.declined.length}): ${byStatus.declined.join(", ") || "none"}`,
    `Healer (${byStatus.healer.length}): ${byStatus.healer.join(", ") || "none"}`,
    `Damage (${byStatus.damage.length}): ${byStatus.damage.join(", ") || "none"}`,
  ];

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("checkin-remind", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const channelId = ctx.channelId;
  if (!channelId) {
    return { content: "This command must be used in a division's check-in channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to send check-in reminders.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(leagueId, channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const roundResult = await resolveRound(
        leagueId,
        ctx.options.round as string | undefined,
        ctx.options.season as string | undefined,
        division.id
      );
      if ("error" in roundResult) {
        return { content: roundResult.error ?? "Something went wrong resolving the round." };
      }
      const round = roundResult.round;
      const supabase = createAdminClient();

      // franchise_rosters.season is TEXT, calendar_rounds.season_number is an
      // integer — cast for the comparison.
      const { data: rostered, error: rosterErr } = await supabase
        .schema("pitboss")
        .from("franchise_rosters")
        .select("driver_id, drivers(discord_id)")
        .eq("league_id", leagueId)
        .eq("season", String(round.season_number))
        .is("released_at", null);

      if (rosterErr) {
        console.error("[checkin-remind] roster lookup failed:", rosterErr);
        return { content: `Something went wrong pulling the roster: ${rosterErr.message}` };
      }

      const { data: checkins, error: checkinErr } = await supabase
        .schema("pitboss")
        .from("round_checkins")
        .select("driver_id")
        .eq("round_id", round.id)
        .eq("division_id", division.id);

      if (checkinErr) {
        console.error("[checkin-remind] check-in lookup failed:", checkinErr);
        return { content: `Something went wrong pulling check-ins: ${checkinErr.message}` };
      }

      const checkedIn = new Set((checkins ?? []).map((c) => c.driver_id));
      const missing = (rostered ?? [])
        .filter((r) => !checkedIn.has(r.driver_id))
        .map((r) => (r as any).drivers?.discord_id)
        .filter(Boolean);

      if (missing.length === 0) {
        return { content: "Everyone's already checked in — nothing to remind." };
      }

      const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
      if (!token) {
        return { content: "PITBOSS_DISCORD_BOT_TOKEN not set — can't post the reminder." };
      }

      const mentions = missing.map((id: string) => `<@${id}>`).join(" ");
      const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `${mentions} — please \`/checkin\` for ${roundLabel(round)}.` }),
      });

      if (!res.ok) {
        console.error("[checkin-remind] channel post failed:", res.status, await res.text());
        return { content: `Reminder failed to post (${res.status}).` };
      }

      return { content: `Reminded ${missing.length} driver(s) who hadn't checked in for ${roundLabel(round)}.` };
    },
  };
});

/**
 * Admin command: posts the rich check-in embed (track/weather/ping
 * delivery/countdown + 5 status buttons) to a division's dedicated
 * check-in channel. One post per round+division — re-running this
 * for the same round/division updates the existing row and posts a
 * fresh message (the old one is left as-is; not deleted, since we
 * don't retain enough context here to safely delete a prior message
 * a driver may have already interacted with).
 *
 * Options: round (optional, defaults to next upcoming), season
 * (optional), division (required: e.g. "D1"), weather (optional free
 * text), ping_delivery (optional free text, defaults to "Channel
 * only"), race_time (optional ISO 8601 datetime — if omitted, falls
 * back to the round's race_date at 15:00 UTC so the countdown still
 * has something to render against).
 *
 * track / country / flag (all optional free text) — manual override
 * for the track line, for when calendar_rounds.circuit/country/
 * flag_emoji is missing or wrong for this round (e.g. a late venue
 * swap that hasn't been fixed on the calendar yet). When set, these
 * win over the round's own circuit/country/flag_emoji in the posted
 * embed — see buildCheckinEmbed's override precedence. `flag` should
 * be a flag emoji (e.g. 🇯🇵) if you want the flag CDN image to still
 * render; a plain country name there will just skip the image.
 *
 * Division is resolved from the `division` option, not the invoking
 * channel — this command is typically run from an admin/mod channel,
 * not the division's own check-in channel, so it uses resolveDivision
 * (explicit code) rather than resolveDivisionByChannel.
 *
 * If race_time actually changes on a re-run (a reschedule), the
 * automated dm_reminder_sent_at / channel_reminder_sent_at stamps are
 * reset to null so pitboss.dispatch_checkin_reminders() fires the 3hr
 * DM / 1hr channel reminders again against the new time instead of
 * treating them as already sent.
 */
registerCommand("checkin-create", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to create a check-in.", ephemeral: true };
  }

  const divisionInput = ctx.options.division as string | undefined;
  if (!divisionInput) {
    return { content: "division is required (e.g. \"D1\").", ephemeral: true };
  }

  const divisionResult = await resolveDivision(leagueId, divisionInput);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    leagueId,
    ctx.options.round as string | undefined,
    ctx.options.season as string | undefined,
    division.id
  );
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;

  const weatherText = (ctx.options.weather as string | undefined) ?? null;
  const pingDelivery = (ctx.options.ping_delivery as string | undefined) ?? "Channel only";
  const raceTime =
    (ctx.options.race_time as string | undefined) ??
    (round.race_date ? `${round.race_date}T15:00:00Z` : null);

  // Manual track override inputs — empty/omitted means "use the round's
  // own calendar_rounds data", not "clear whatever was set before" (a
  // re-run of checkin-create for the same round/division without these
  // options keeps the previously entered override via upsert semantics
  // only if we don't overwrite with null — so we explicitly read what's
  // already stored when the option wasn't passed this time).
  const trackOverrideInput = ctx.options.track as string | undefined;
  const countryOverrideInput = ctx.options.country as string | undefined;
  const flagOverrideInput = ctx.options.flag as string | undefined;

  const supabase = createAdminClient();

  // Always read the existing row first — needed both to preserve
  // untouched overrides (below) and to detect a race_time reschedule
  // (so the reminder-sent stamps can be reset).
  const { data: existingPost } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .select("race_time, track_override, country_override, flag_override")
    .eq("round_id", round.id)
    .eq("division_id", division.id)
    .maybeSingle();

  let trackOverride = trackOverrideInput ?? null;
  let countryOverride = countryOverrideInput ?? null;
  let flagOverride = flagOverrideInput ?? null;

  if (trackOverrideInput === undefined && countryOverrideInput === undefined && flagOverrideInput === undefined) {
    // No override options passed this run — preserve whatever was
    // previously stored for this round+division instead of clearing it.
    trackOverride = existingPost?.track_override ?? null;
    countryOverride = existingPost?.country_override ?? null;
    flagOverride = existingPost?.flag_override ?? null;
  }

  // race_time changed (a reschedule) → reset both reminder stamps so the
  // 3hr DM / 1hr channel pings fire again against the new time. Leave
  // them untouched on an unrelated re-run (e.g. just updating weather)
  // so we don't send a duplicate reminder for the same race time.
  const raceTimeChanged =
    existingPost != null &&
    (existingPost.race_time ? new Date(existingPost.race_time).getTime() : null) !==
      (raceTime ? new Date(raceTime).getTime() : null);

  const upsertPayload: Record<string, unknown> = {
    round_id: round.id,
    division_id: division.id,
    discord_channel_id: division.discord_checkin_channel_id,
    weather_text: weatherText,
    ping_delivery: pingDelivery,
    race_time: raceTime,
    track_override: trackOverride,
    country_override: countryOverride,
    flag_override: flagOverride,
    updated_at: new Date().toISOString(),
  };
  if (raceTimeChanged) {
    upsertPayload.dm_reminder_sent_at = null;
    upsertPayload.channel_reminder_sent_at = null;
  }

  const { data: post, error: postError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .upsert(upsertPayload, { onConflict: "round_id,division_id" })
    .select("id, weather_text, ping_delivery, race_time, track_override, country_override, flag_override")
    .single();

  if (postError || !post) {
    console.error("[checkin-create] post upsert failed:", postError);
    return { content: `Something went wrong saving the check-in post: ${postError?.message ?? "unknown error"}`, ephemeral: true };
  }

  const groupedResult = await fetchGroupedCheckins(round.id, division.id);
  if ("error" in groupedResult) {
    return { content: `Something went wrong pulling existing check-ins: ${groupedResult.error}`, ephemeral: true };
  }

  const embed = buildCheckinEmbed({
    round,
    divisionCode: division.division_code,
    post,
    grouped: groupedResult.grouped,
  });
  const components = buildCheckinComponents(post.id);

  const token = process.env.PITBOSS_DISCORD_BOT_TOKEN;
  if (!token) {
    return { content: "PITBOSS_DISCORD_BOT_TOKEN not set — can't post the check-in.", ephemeral: true };
  }

  const res = await fetch(`${DISCORD_API_BASE}/channels/${division.discord_checkin_channel_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed], components }),
  });

  if (!res.ok) {
    console.error("[checkin-create] channel post failed:", res.status, await res.text());
    return { content: `Check-in post failed to send (${res.status}).`, ephemeral: true };
  }

  const posted = await res.json();
  const { error: msgIdError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .update({ discord_message_id: posted.id })
    .eq("id", post.id);

  if (msgIdError) {
    console.error("[checkin-create] failed to save discord_message_id:", msgIdError);
    // Not fatal to the user — the message posted fine, buttons still work
    // (they carry the post id, not the message id). Logged for follow-up.
  }

  return {
    content: `Check-in posted for ${roundLabel(round)} — Division ${division.division_code}.`,
    ephemeral: true,
  };
});

registerCommand("generate-grid", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const channelId = ctx.channelId;
  if (!channelId) {
    return { content: "This command must be used in a division's check-in channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to generate the grid.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(leagueId, channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const regenerate = Boolean(ctx.options.regenerate);

  const roundResult = await resolveRound(
    leagueId,
    ctx.options.round as string | undefined,
    ctx.options.season as string | undefined,
    division.id
  );
  if ("error" in roundResult) {
    return { content: roundResult.error ?? "Something went wrong resolving the round.", ephemeral: true };
  }
  const round = roundResult.round;
  const supabase = createAdminClient();

  if (!regenerate) {
    const { data: existing } = await supabase
      .schema("pitboss")
      .from("round_grid_entries")
      .select("id")
      .eq("round_id", round.id)
      .limit(1);
    if (existing && existing.length > 0) {
      return {
        content: "A grid already exists for this round. Re-run with `regenerate: true` to rebuild it.",
        ephemeral: true,
      };
    }
  }

  const { data: confirmed, error: confirmedErr } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("driver_id, drivers(discord_id)")
    .eq("round_id", round.id)
    .eq("division_id", division.id)
    .eq("status", "confirmed");

  if (confirmedErr) {
    console.error("[generate-grid] confirmed check-ins lookup failed:", confirmedErr);
    return { content: `Something went wrong pulling confirmed check-ins: ${confirmedErr.message}`, ephemeral: true };
  }
  if (!confirmed || confirmed.length === 0) {
    return { content: "No confirmed check-ins for this round yet.", ephemeral: true };
  }

  const driverIds = confirmed.map((c) => c.driver_id);
  const { data: rosters, error: rosterErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("driver_id, franchise_id, tier")
    .eq("league_id", leagueId)
    .eq("season", String(round.season_number))
    .is("released_at", null)
    .in("driver_id", driverIds);

  if (rosterErr) {
    console.error("[generate-grid] roster lookup failed:", rosterErr);
    return { content: `Something went wrong pulling rosters: ${rosterErr.message}`, ephemeral: true };
  }

  // franchise_rosters (pitboss) and franchises (rise_os) live in
  // different exposed PostgREST schemas — cross-schema embeds
  // (`franchises(name)`) aren't resolvable via the schema cache even
  // though the FK is valid, so franchise names are fetched separately
  // and joined in-memory below. See PATCH note at top of file.
  const franchiseIds = [...new Set((rosters ?? []).map((r) => r.franchise_id))];
  const { data: franchises, error: franchiseErr } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name")
    .in("id", franchiseIds);

  if (franchiseErr) {
    console.error("[generate-grid] franchise lookup failed:", franchiseErr);
    return { content: `Something went wrong pulling franchise names: ${franchiseErr.message}`, ephemeral: true };
  }
  const franchiseNameById = new Map((franchises ?? []).map((f) => [f.id, f.name]));

  if (regenerate) {
    await supabase.schema("pitboss").from("round_grid_entries").delete().eq("round_id", round.id);
  }

  // franchise_id is NOT NULL on round_grid_entries — any confirmed driver
  // without an active roster row is silently dropped here rather than
  // inserted with a null franchise_id. Surface that gap to the caller.
  const rows = (rosters ?? []).map((r) => ({
    round_id: round.id,
    league_id: leagueId,
    driver_id: r.driver_id,
    franchise_id: r.franchise_id,
    tier: r.tier,
    generated_by: ctx.discordUserId,
  }));

  const { error: insertErr } = await supabase.schema("pitboss").from("round_grid_entries").insert(rows);
  if (insertErr) {
    console.error("[generate-grid] grid insert failed:", insertErr);
    return { content: `Something went wrong saving the grid: ${insertErr.message}`, ephemeral: true };
  }

  const skipped = confirmed.length - rows.length;
  const lines = [`**Grid — ${roundLabel(round)} — Division ${division.division_code}** (${rows.length} drivers)`];
  for (const r of rosters ?? []) {
    const discordId = (confirmed.find((c) => c.driver_id === r.driver_id) as any)?.drivers?.discord_id;
    const franchiseName = franchiseNameById.get(r.franchise_id) ?? "Unknown";
    lines.push(`${franchiseName}: ${discordId ? `<@${discordId}>` : r.driver_id}`);
  }
  if (skipped > 0) {
    lines.push(`_${skipped} confirmed driver(s) skipped — no active roster entry for season ${round.season_number}._`);
  }

  return { content: lines.join("\n"), ephemeral: false };
});

// Side-effect import: registers the roster_* commands.
import "./roster";
// Side-effect import: registers the kb_* commands.
import "./kb";
// Side-effect import: registers the steward_* commands.
import "./steward";
// Side-effect import: registers the appeal_* commands.
import "./appeal";
// Side-effect import: registers the kick/ban/lockdown/endlockdown commands.
import "./moderation";
// Side-effect import: registers the sign-driver/release-driver commands.
import "./driver";
