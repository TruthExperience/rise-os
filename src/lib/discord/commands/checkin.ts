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
  const status = ctx.options.status as CheckinStatus;
  if (!status) {
    return { content: "status is required.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(ctx.leagueId, ctx.channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    ctx.leagueId,
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
        league_id: ctx.leagueId,
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
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to view check-in status.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(ctx.leagueId, ctx.channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    ctx.leagueId,
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
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to send check-in reminders.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(ctx.leagueId, ctx.channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const roundResult = await resolveRound(
        ctx.leagueId,
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
        .eq("league_id", ctx.leagueId)
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
      const res = await fetch(`${DISCORD_API_BASE}/channels/${ctx.channelId}/messages`, {
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
 * Division is resolved from the `division` option, not the invoking
 * channel — this command is typically run from an admin/mod channel,
 * not the division's own check-in channel, so it uses resolveDivision
 * (explicit code) rather than resolveDivisionByChannel.
 */
registerCommand("checkin-create", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to create a check-in.", ephemeral: true };
  }

  const divisionInput = ctx.options.division as string | undefined;
  if (!divisionInput) {
    return { content: "division is required (e.g. \"D1\").", ephemeral: true };
  }

  const divisionResult = await resolveDivision(ctx.leagueId, divisionInput);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const roundResult = await resolveRound(
    ctx.leagueId,
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

  const supabase = createAdminClient();

  const { data: post, error: postError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .upsert(
      {
        round_id: round.id,
        division_id: division.id,
        discord_channel_id: division.discord_checkin_channel_id,
        weather_text: weatherText,
        ping_delivery: pingDelivery,
        race_time: raceTime,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "round_id,division_id" }
    )
    .select("id, weather_text, ping_delivery, race_time")
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
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to generate the grid.", ephemeral: true };
  }

  const divisionResult = await resolveDivisionByChannel(ctx.leagueId, ctx.channelId);
  if ("error" in divisionResult) {
    return { content: divisionResult.error ?? "Something went wrong resolving the division.", ephemeral: true };
  }
  const division = divisionResult.division;

  const regenerate = Boolean(ctx.options.regenerate);

  const roundResult = await resolveRound(
    ctx.leagueId,
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
    .select("driver_id, franchise_id, tier, franchises(name)")
    .eq("league_id", ctx.leagueId)
    .eq("season", String(round.season_number))
    .is("released_at", null)
    .in("driver_id", driverIds);

  if (rosterErr) {
    console.error("[generate-grid] roster lookup failed:", rosterErr);
    return { content: `Something went wrong pulling rosters: ${rosterErr.message}`, ephemeral: true };
  }

  if (regenerate) {
    await supabase.schema("pitboss").from("round_grid_entries").delete().eq("round_id", round.id);
  }

  // franchise_id is NOT NULL on round_grid_entries — any confirmed driver
  // without an active roster row is silently dropped here rather than
  // inserted with a null franchise_id. Surface that gap to the caller.
  const rows = (rosters ?? []).map((r) => ({
    round_id: round.id,
    league_id: ctx.leagueId,
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
    const franchiseName = (r as any).franchises?.name ?? "Unknown";
    lines.push(`${franchiseName}: ${discordId ? `<@${discordId}>` : r.driver_id}`);
  }
  if (skipped > 0) {
    lines.push(`_${skipped} confirmed driver(s) skipped — no active roster entry for season ${round.season_number}._`);
  }

  return { content: lines.join("\n"), ephemeral: false };
});
