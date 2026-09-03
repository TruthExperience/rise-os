import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Tables now confirmed against live schema:
//   rise_os.calendar_rounds   (was guessed as pitboss.race_rounds)
//   pitboss.round_checkins    (was guessed as pitboss.race_checkins)
//   pitboss.round_grid_entries (was guessed as pitboss.race_grids)

const ADMIN_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
  "is_head_steward",
  "is_steward",
] as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

type CheckinStatus = "confirmed" | "tentative" | "declined";

async function getOrCreateDriver(discordId: string, resolvedUsername: string | undefined) {
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
 * NOTE: calendar_rounds lives in the rise_os schema, not pitboss.
 */
async function resolveRound(leagueId: string, roundInput: string | undefined, seasonInput: string | undefined) {
  const supabase = createAdminClient();
  let query = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("id, season_number, round_number, name, race_date")
    .eq("league_id", leagueId);

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

function roundLabel(round: { name: string | null; round_number: number | null }) {
  return round.name ?? (round.round_number != null ? `Round ${round.round_number}` : "this round");
}

registerCommand("checkin", async (ctx) => {
  const status = ctx.options.status as CheckinStatus;
  if (!status) {
    return { content: "status is required.", ephemeral: true };
  }

  const roundResult = await resolveRound(ctx.leagueId, ctx.options.round as string | undefined, ctx.options.season as string | undefined);
  if ("error" in roundResult) {
    return { content: roundResult.error, ephemeral: true };
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

  const roundResult = await resolveRound(ctx.leagueId, ctx.options.round as string | undefined, ctx.options.season as string | undefined);
  if ("error" in roundResult) {
    return { content: roundResult.error, ephemeral: true };
  }
  const round = roundResult.round;

  const supabase = createAdminClient();
  const { data: checkins, error } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("status, driver_id, drivers(discord_id)")
    .eq("round_id", round.id);

  if (error) {
    console.error("[checkin-status] lookup failed:", error);
    return { content: `Something went wrong pulling check-ins: ${error.message}`, ephemeral: true };
  }

  const byStatus: Record<CheckinStatus, string[]> = { confirmed: [], tentative: [], declined: [] };
  for (const row of checkins ?? []) {
    const discordId = (row as any).drivers?.discord_id;
    if (discordId && row.status in byStatus) {
      byStatus[row.status as CheckinStatus].push(`<@${discordId}>`);
    }
  }

  const lines = [
    `**Check-in status — ${roundLabel(round)}**`,
    `Confirmed (${byStatus.confirmed.length}): ${byStatus.confirmed.join(", ") || "none"}`,
    `Tentative (${byStatus.tentative.length}): ${byStatus.tentative.join(", ") || "none"}`,
    `Declined (${byStatus.declined.length}): ${byStatus.declined.join(", ") || "none"}`,
  ];

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("checkin-remind", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to send check-in reminders.", ephemeral: true };
  }

  return {
    defer: true,
    ephemeral: false,
    background: async () => {
      const roundResult = await resolveRound(ctx.leagueId, ctx.options.round as string | undefined, ctx.options.season as string | undefined);
      if ("error" in roundResult) {
        return { content: roundResult.error };
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
        .eq("round_id", round.id);

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

registerCommand("generate-grid", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...ADMIN_FLAGS])) {
    return { content: "You don't have permission to generate the grid.", ephemeral: true };
  }

  const regenerate = Boolean(ctx.options.regenerate);

  const roundResult = await resolveRound(ctx.leagueId, ctx.options.round as string | undefined, ctx.options.season as string | undefined);
  if ("error" in roundResult) {
    return { content: roundResult.error, ephemeral: true };
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
  const lines = [`**Grid — ${roundLabel(round)}** (${rows.length} drivers)`];
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
