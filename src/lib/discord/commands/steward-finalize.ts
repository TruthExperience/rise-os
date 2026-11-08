// src/lib/discord/commands/steward-finalize.ts
//
// /steward finalize_round round:<n> [season:<n>]
//
// Calls pitboss.finalize_round(p_round_id, p_finalized_by). That function
// refuses while any incident is open / under review / appealed and while no
// results are entered, then updates clean_race_streak + clean-race decay and
// flips rise_os.calendar_rounds.status to 'final'.
//
// DDV: trg_calc_ddv_on_round_final (on rise_os.calendar_rounds) runs
// pitboss.calc_ddv_for_round when status flips to 'final', so finalizing here
// is what updates the DDV leaderboard. calc_ddv_for_round is idempotent per
// round, so finalizing a round whose DDV was already calculated is safe.
//
// Finalizing blocks new appeals for the round's incidents.

import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { hasDiscordStewardAccess } from "../permissions";

registerCommand("steward_finalize_round", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }
  const guildId = ctx.guildId;
  if (!guildId) {
    return { content: "This command must be used in a server.", ephemeral: true };
  }

  const supabase = createAdminClient();

  // Same gate as the other /steward commands: stewards, commissioners, owners.
  const { data: leagueConfig } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("discord_steward_role_id")
    .eq("id", leagueId)
    .maybeSingle();

  if (
    !hasDiscordStewardAccess(
      {
        memberRoles: ctx.memberRoles,
        memberPermissions: ctx.memberPermissions,
      },
      leagueConfig?.discord_steward_role_id ?? null,
    )
  ) {
    return { content: "Only stewards, commissioners, or owners can do that.", ephemeral: true };
  }

  const roundNumber = ctx.options.round as number | undefined;
  if (!roundNumber) {
    return { content: "Specify a round number.", ephemeral: true };
  }
  const seasonOption = ctx.options.season as number | undefined;

  // Resolve the calendar round. Without a season, use the league's latest
  // season that has this round number.
  let roundQuery = supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("id, season_number, round_number, name, status")
    .eq("league_id", leagueId)
    .eq("round_number", roundNumber);
  if (seasonOption) roundQuery = roundQuery.eq("season_number", seasonOption);

  const { data: roundRows, error: roundErr } = await roundQuery;
  if (roundErr) {
    console.error("[steward_finalize_round] round lookup failed:", roundErr);
    return { content: `Couldn't look up the round: ${roundErr.message}`, ephemeral: true };
  }
  if (!roundRows || roundRows.length === 0) {
    return {
      content: `No round ${roundNumber}${seasonOption ? ` in season ${seasonOption}` : ""} found for this league.`,
      ephemeral: true,
    };
  }

  const latestSeason = Math.max(...roundRows.map((r) => Number(r.season_number)));
  const candidates = seasonOption
    ? roundRows
    : roundRows.filter((r) => Number(r.season_number) === latestSeason);

  if (candidates.length > 1) {
    return {
      content: `Round ${roundNumber} matches ${candidates.length} calendar entries (multiple divisions?). Finalize it from the web app instead.`,
      ephemeral: true,
    };
  }

  const round = candidates[0];
  const label = `S${round.season_number} R${round.round_number}${round.name ? ` — ${round.name}` : ""}`;

  if (round.status === "final") {
    return { content: `**${label}** is already finalized.`, ephemeral: true };
  }
  if (round.status === "cancelled") {
    return { content: `**${label}** is cancelled and can't be finalized.`, ephemeral: true };
  }

  // finalized_by must be a pitboss.drivers id.
  const { data: finalizer } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();
  if (!finalizer) {
    return {
      content: "You don't have a driver record yet — interact with the bot once first, then retry.",
      ephemeral: true,
    };
  }

  const { error: finalizeErr } = await supabase
    .schema("pitboss")
    .rpc("finalize_round", { p_round_id: round.id, p_finalized_by: finalizer.id });

  if (finalizeErr) {
    // finalize_round raises readable messages (open incidents, no results, ...).
    console.error("[steward_finalize_round] failed:", finalizeErr);
    return { content: `Couldn't finalize **${label}**: ${finalizeErr.message}`, ephemeral: true };
  }

  // The DDV trigger swallows its own errors (so it can never block a
  // finalize). Check it actually wrote rows and say so if not.
  const { count: ddvRows } = await supabase
    .schema("pitboss")
    .from("driver_ddv_history")
    .select("id", { count: "exact", head: true })
    .eq("league_id", leagueId)
    .eq("round_id", round.id)
    .eq("event_type", "race_weekend");

  const ddvLine =
    (ddvRows ?? 0) > 0
      ? `DDV updated for ${ddvRows} driver(s).`
      : "⚠️ Round finalized, but no DDV rows were written. Check the logs for a `ddv calc failed` warning.";

  return {
    content: `✅ **${label}** finalized. Appeals for this round are now closed. ${ddvLine}`,
    ephemeral: true,
  };
});
