import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Same editor gate roster_assign/roster_remove use. Duplicated here rather
// than imported because roster.ts doesn't export it — worth centralizing
// later if a third command needs it.
const EDITOR_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
  "is_head_steward",
  "is_steward",
] as const;

async function resolveFranchise(leagueId: string, input: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division")
    .eq("league_id", leagueId)
    .or(`name.ilike.%${input}%,abbreviation.ilike.%${input}%`);

  if (error) return { error: error.message } as const;
  if (!data || data.length === 0) {
    return { error: `No franchise matching "${input}" found in this league.` } as const;
  }
  if (data.length > 1) {
    // Common case: HRL-style leagues where the same real-world team name
    // exists in multiple divisions ("McLaren 25" / "McLaren 26"). Force
    // the caller to disambiguate rather than guessing which one they meant.
    const names = data.map((f) => `${f.name} (${f.division ?? "no division"})`).join(", ");
    return { error: `"${input}" matches more than one franchise: ${names}. Be more specific.` } as const;
  }
  return { franchise: data[0] } as const;
}

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

registerCommand("sign-driver", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return { content: "You don't have permission to sign drivers.", ephemeral: true };
  }

  const targetDiscordId = ctx.options.driver as string;
  const franchiseInput = ctx.options.franchise as string;
  const tierInput = ((ctx.options.tier as string) ?? "").trim();
  const season = ctx.options.season as string;

  if (!targetDiscordId || !franchiseInput || !season) {
    return { content: "driver, franchise, and season are all required.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const franchiseResult = await resolveFranchise(ctx.leagueId, franchiseInput);
  if ("error" in franchiseResult) {
    return { content: `${franchiseResult.error}`, ephemeral: true };
  }
  const franchise = franchiseResult.franchise;

  const resolvedUsername = ctx.resolvedUsers[targetDiscordId]?.username;
  const driverResult = await getOrCreateDriver(targetDiscordId, resolvedUsername);
  if ("error" in driverResult) {
    return { content: `Couldn't resolve driver: ${driverResult.error}`, ephemeral: true };
  }
  const driver = driverResult.driver;

  // Refuse to double-sign: a driver can only hold one active roster spot
  // per league/season (enforced at the DB level too, via a partial unique
  // index — this check just gives a clearer error message).
  const { data: existingActive, error: existingErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("id, franchise_id")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .eq("season", season)
    .is("released_at", null)
    .maybeSingle();

  if (existingErr) {
    console.error("[sign-driver] active roster check failed:", existingErr);
    return { content: `Something went wrong checking the current roster: ${existingErr.message}`, ephemeral: true };
  }
  if (existingActive) {
    return {
      content:
        existingActive.franchise_id === franchise.id
          ? `<@${targetDiscordId}> is already signed to ${franchise.name} for ${season}.`
          : `<@${targetDiscordId}> is already signed to another franchise for ${season}. Release them first.`,
      ephemeral: true,
    };
  }

  const { error: membershipUpsertError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .upsert(
      { driver_id: driver.id, league_id: ctx.leagueId, is_driver: true },
      { onConflict: "driver_id,league_id" }
    );
  if (membershipUpsertError) {
    console.error("[sign-driver] driver_leagues upsert failed:", membershipUpsertError);
    return {
      content: `Something went wrong linking the driver to this league: ${membershipUpsertError.message}`,
      ephemeral: true,
    };
  }

  const { error: rosterInsertError } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .insert({
      driver_id: driver.id,
      franchise_id: franchise.id,
      league_id: ctx.leagueId,
      division: franchise.division,
      season,
      tier: tierInput || null,
      source: "discord:/sign-driver",
      created_by: ctx.discordUserId,
    });
  if (rosterInsertError) {
    console.error("[sign-driver] franchise_rosters insert failed:", rosterInsertError);
    return { content: `Something went wrong saving the roster record: ${rosterInsertError.message}`, ephemeral: true };
  }

  // Branch on financial model: a cap-model league (rows in
  // league_financial_config) gets a driver_contracts row; an
  // event-economy league (e.g. HRL, rows in league_event_economy_rules
  // instead) gets driver_leagues.market_value set from the matching
  // signing_<tier> rule. A league with neither just gets the roster
  // record above and nothing financial — that's a legitimate state, not
  // an error, since not every league has set up its economy yet.
  const { data: capConfig } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("division")
    .eq("league_id", ctx.leagueId)
    .limit(1);

  const financialNotes: string[] = [];

  if (capConfig && capConfig.length > 0) {
    const { error: contractError } = await supabase
      .schema("pitboss")
      .from("driver_contracts")
      .insert({
        driver_id: driver.id,
        franchise_id: franchise.id,
        league_id: ctx.leagueId,
        contract_class: tierInput || "T1",
        division: franchise.division,
        season_start: season,
        status: "active",
      });
    if (contractError) {
      console.error("[sign-driver] driver_contracts insert failed:", contractError);
      financialNotes.push(
        `Roster saved, but the contract record failed: ${contractError.message}. Needs manual follow-up.`
      );
    } else {
      financialNotes.push(`Contract created (${tierInput || "T1"}).`);
    }
  } else {
    const tierKey = tierInput.toLowerCase().replace(/\s+/g, "_");
    const ruleKey = tierKey ? `signing_${tierKey}` : null;

    if (!ruleKey) {
      financialNotes.push(
        "No tier given, so no starting market value was set — this league prices signings by tier (e.g. D1/D2/Reserve)."
      );
    } else {
      const { data: rule, error: ruleError } = await supabase
        .schema("pitboss")
        .from("league_event_economy_rules")
        .select("driver_value_delta")
        .eq("league_id", ctx.leagueId)
        .eq("rule_key", ruleKey)
        .maybeSingle();

      if (ruleError || !rule) {
        financialNotes.push(
          `Roster saved, but no signing rule found for tier "${tierInput}" — market value wasn't set.`
        );
      } else {
        const { error: marketValueError } = await supabase
          .schema("pitboss")
          .from("driver_leagues")
          .update({ market_value: rule.driver_value_delta })
          .eq("driver_id", driver.id)
          .eq("league_id", ctx.leagueId);
        if (marketValueError) {
          console.error("[sign-driver] market_value update failed:", marketValueError);
          financialNotes.push(`Roster saved, but setting market value failed: ${marketValueError.message}.`);
        } else {
          financialNotes.push(`Market value set to ${rule.driver_value_delta}.`);
        }
      }
    }
  }

  return {
    content: `Signed <@${targetDiscordId}> to **${franchise.name}** for ${season}. ${financialNotes.join(" ")}`,
    ephemeral: false,
  };
});

registerCommand("release-driver", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return { content: "You don't have permission to release drivers.", ephemeral: true };
  }

  const targetDiscordId = ctx.options.driver as string;
  const season = ctx.options.season as string;
  const reason = (ctx.options.reason as string) ?? null;

  if (!targetDiscordId || !season) {
    return { content: "driver and season are both required.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", targetDiscordId)
    .maybeSingle();

  if (!driver) {
    return { content: "That driver isn't on file.", ephemeral: true };
  }

  const { data: activeRoster, error: activeErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("id, franchise_id")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .eq("season", season)
    .is("released_at", null)
    .maybeSingle();

  if (activeErr) {
    console.error("[release-driver] active roster lookup failed:", activeErr);
    return { content: `Something went wrong looking up the roster: ${activeErr.message}`, ephemeral: true };
  }
  if (!activeRoster) {
    return { content: `<@${targetDiscordId}> isn't currently signed to a franchise for ${season}.`, ephemeral: true };
  }

  const releasedAt = new Date().toISOString();

  const { error: releaseError } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .update({ released_at: releasedAt, released_reason: reason })
    .eq("id", activeRoster.id);

  if (releaseError) {
    console.error("[release-driver] franchise_rosters release failed:", releaseError);
    return { content: `Something went wrong releasing that driver: ${releaseError.message}`, ephemeral: true };
  }

  // Mirror into driver_contracts if this is a cap-model league. Harmless
  // no-op (zero rows matched) for event-economy leagues like HRL, since
  // they never get a driver_contracts row from /sign-driver in the first
  // place.
  const { error: contractReleaseError } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .update({ status: "released", released_at: releasedAt, released_reason: reason })
    .eq("driver_id", driver.id)
    .eq("franchise_id", activeRoster.franchise_id)
    .eq("league_id", ctx.leagueId)
    .eq("season_start", season)
    .eq("status", "active");
  if (contractReleaseError) {
    console.error("[release-driver] driver_contracts release update failed (non-fatal):", contractReleaseError);
  }

  return {
    content: `Released <@${targetDiscordId}> from ${season}${reason ? ` (${reason})` : ""}.`,
    ephemeral: false,
  };
});
