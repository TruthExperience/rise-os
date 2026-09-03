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

// season is a free-text Discord option, so people type "3", "3 seasons",
// "Season 3", etc. Every write and every lookup MUST go through this so
// sign-driver and release-driver always agree on what's stored — a raw
// string mismatch here is what caused the 2026-09-03 stuck-roster bug
// (signed with "3 seasons", release attempts tried "3" / "1" / "audi 26
// 3seasons", none of which matched the literal stored string).
function normalizeSeason(raw: string): { season: string } | { error: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/\d+/);
  if (!match) {
    return { error: `Season must contain a number (e.g. "3"). Got: "${raw}".` };
  }
  return { season: match[0] };
}

// HRL (and similarly modeled event-economy leagues) use D<n>/Reserve and
// T<n> interchangeably for the same signing tier ("T2 is D2" — league
// admin, 2026-09-03). Try both prefixes when resolving a signing_<tier>
// rule so a rule defined under one naming convention still resolves for
// the other, instead of requiring someone to notice the miss and
// manually add a duplicate alias row (which is what happened last time —
// the driver signed before signing_t2 existed and got no market value).
//
// Also handles a bare numeric tier ("2" with no T/D prefix at all) —
// people type it that way often enough that it needs both prefixes
// tried, not just a same-prefix swap. This was missed in the first pass:
// tierKey "2" doesn't start with "t" or "d", so no alias was generated
// and only "signing_2" (which never exists) was tried.
function tierAliasKeys(tierKey: string): string[] {
  if (/^\d+$/.test(tierKey)) {
    return [`t${tierKey}`, `d${tierKey}`, tierKey];
  }
  const keys = [tierKey];
  if (tierKey.startsWith("t")) keys.push("d" + tierKey.slice(1));
  else if (tierKey.startsWith("d")) keys.push("t" + tierKey.slice(1));
  return keys;
}

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

// Deducts a signing's team_budget_delta from the franchise's wallet and
// logs the transaction. Event-economy leagues only — cap-model leagues
// track spend via driver_contracts.contract_value instead, they never
// call this. Added 2026-09-03: signing rules previously only set
// driver_leagues.market_value and never touched the wallet at all, which
// is why every HRL wallet sat at its untouched starting_wallet no matter
// how many drivers a franchise had actually signed.
async function deductSigningFromWallet(params: {
  franchiseId: string;
  division: string | null;
  leagueId: string;
  season: string;
  amount: number; // expected negative (a cost)
  description: string;
}): Promise<{ error: string } | { newBalance: number }> {
  const supabase = createAdminClient();

  const { data: wallet, error: walletFetchError } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("id, balance")
    .eq("franchise_id", params.franchiseId)
    .eq("division", params.division ?? "")
    .maybeSingle();

  if (walletFetchError) {
    return { error: walletFetchError.message };
  }
  if (!wallet) {
    return { error: `No wallet found for this franchise/division (${params.division ?? "no division"}).` };
  }

  const currentBalance = typeof wallet.balance === "string" ? Number(wallet.balance) : wallet.balance;
  const newBalance = currentBalance + params.amount;

  const { error: txError } = await supabase
    .schema("pitboss")
    .from("wallet_transactions")
    .insert({
      wallet_id: wallet.id,
      franchise_id: params.franchiseId,
      league_id: params.leagueId,
      season: params.season,
      transaction_type: "contract_signing",
      amount: params.amount,
      balance_after: newBalance,
      related_type: "driver_leagues",
      description: params.description,
    });
  if (txError) {
    return { error: txError.message };
  }

  const { error: balanceUpdateError } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .update({ balance: newBalance })
    .eq("id", wallet.id);
  if (balanceUpdateError) {
    return { error: balanceUpdateError.message };
  }

  return { newBalance };
}

registerCommand("sign-driver", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return { content: "You don't have permission to sign drivers.", ephemeral: true };
  }

  const targetDiscordId = ctx.options.driver as string;
  const franchiseInput = ctx.options.franchise as string;
  const tierInput = ((ctx.options.tier as string) ?? "").trim();
  const rawSeason = ctx.options.season as string;

  if (!targetDiscordId || !franchiseInput || !rawSeason) {
    return { content: "driver, franchise, and season are all required.", ephemeral: true };
  }

  const seasonResult = normalizeSeason(rawSeason);
  if ("error" in seasonResult) {
    return { content: seasonResult.error, ephemeral: true };
  }
  const season = seasonResult.season;

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
  // per league at a time (enforced at the DB level too, via a partial
  // unique index — this check just gives a clearer error message).
  // Matched on driver+league+released_at only — NOT season — because
  // season is free text and a formatting mismatch here previously let a
  // driver get double-signed under two different season strings.
  const { data: existingActive, error: existingErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("id, franchise_id, season")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
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
          ? `<@${targetDiscordId}> is already signed to ${franchise.name} (season ${existingActive.season}).`
          : `<@${targetDiscordId}> is already signed to another franchise (season ${existingActive.season}). Release them first.`,
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
  // signing_<tier> rule, AND — as of 2026-09-03 — a wallet deduction if
  // that rule also carries a team_budget_delta. A league with neither
  // just gets the roster record above and nothing financial — that's a
  // legitimate state, not an error, since not every league has set up
  // its economy yet.
  const { data: capConfig } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("division")
    .eq("league_id", ctx.leagueId)
    .limit(1);

  const financialNotes: string[] = [];

  if (capConfig && capConfig.length > 0) {
    const contractClass = tierInput ? tierInput.toUpperCase() : "T1";
    const { error: contractError } = await supabase
      .schema("pitboss")
      .from("driver_contracts")
      .insert({
        driver_id: driver.id,
        franchise_id: franchise.id,
        league_id: ctx.leagueId,
        contract_class: contractClass,
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
      financialNotes.push(`Contract created (${contractClass}).`);
    }
  } else {
    const tierKey = tierInput.toLowerCase().replace(/\s+/g, "_");

    if (!tierKey) {
      financialNotes.push(
        "No tier given, so no starting market value was set and nothing was deducted — this league prices signings by tier (e.g. D1/D2/Reserve)."
      );
    } else {
      let rule: { driver_value_delta: number | string | null; team_budget_delta: number | string | null } | null =
        null;
      let lookupError: string | null = null;

      for (const candidateKey of tierAliasKeys(tierKey)) {
        const { data, error: ruleError } = await supabase
          .schema("pitboss")
          .from("league_event_economy_rules")
          .select("driver_value_delta, team_budget_delta")
          .eq("league_id", ctx.leagueId)
          .eq("rule_key", `signing_${candidateKey}`)
          .maybeSingle();

        if (ruleError) {
          lookupError = ruleError.message;
          break;
        }
        if (data) {
          rule = data;
          break;
        }
      }

      if (lookupError) {
        financialNotes.push(`Roster saved, but the signing-rule lookup failed: ${lookupError}.`);
      } else if (!rule) {
        financialNotes.push(
          `Roster saved, but no signing rule found for tier "${tierInput}" (tried "${tierAliasKeys(tierKey)
            .map((k) => `signing_${k}`)
            .join('", "')}") — market value wasn't set and nothing was deducted. Add the rule to league_event_economy_rules and rerun the market-value update for this driver.`
        );
      } else {
        if (rule.driver_value_delta !== null && rule.driver_value_delta !== undefined) {
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

        const budgetDelta =
          rule.team_budget_delta === null || rule.team_budget_delta === undefined
            ? null
            : typeof rule.team_budget_delta === "string"
            ? Number(rule.team_budget_delta)
            : rule.team_budget_delta;

        if (budgetDelta !== null && budgetDelta !== 0) {
          const deductionResult = await deductSigningFromWallet({
            franchiseId: franchise.id,
            division: franchise.division,
            leagueId: ctx.leagueId,
            season,
            amount: budgetDelta,
            description: `Salary deduction for driver signing (${tierInput.toUpperCase()})`,
          });
          if ("error" in deductionResult) {
            console.error("[sign-driver] wallet deduction failed:", deductionResult.error);
            financialNotes.push(
              `Market value set, but the wallet deduction of ${budgetDelta} failed: ${deductionResult.error}. Needs manual follow-up.`
            );
          } else {
            financialNotes.push(
              `${Math.abs(budgetDelta).toLocaleString()} deducted from team budget (new balance: ${deductionResult.newBalance.toLocaleString()}).`
            );
          }
        }
      }
    }
  }

  return {
    content: `Signed <@${targetDiscordId}> to **${franchise.name}** for season ${season}. ${financialNotes.join(" ")}`,
    ephemeral: false,
  };
});

registerCommand("release-driver", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return { content: "You don't have permission to release drivers.", ephemeral: true };
  }

  const targetDiscordId = ctx.options.driver as string;
  const rawSeason = ctx.options.season as string | undefined;
  const reason = (ctx.options.reason as string) ?? null;

  if (!targetDiscordId) {
    return { content: "driver is required.", ephemeral: true };
  }

  // season is now optional and, when given, is a sanity note only — NOT
  // a lookup key. Making it a required exact-string match against
  // whatever sign-driver happened to store is exactly what caused the
  // 2026-09-03 bug: three release attempts ("3", "1", "audi 26
  // 3seasons") all failed to match the literal stored value "3 seasons".
  // A driver can only hold one active roster spot per league at a time
  // (see the matching comment in sign-driver), so driver+league+
  // released_at IS NULL is sufficient on its own to find it.
  let seasonNote: string | null = null;
  if (rawSeason) {
    const seasonResult = normalizeSeason(rawSeason);
    if ("error" in seasonResult) {
      return { content: seasonResult.error, ephemeral: true };
    }
    seasonNote = seasonResult.season;
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

  const { data: activeRosters, error: activeErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("id, franchise_id, season")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .is("released_at", null);

  if (activeErr) {
    console.error("[release-driver] active roster lookup failed:", activeErr);
    return { content: `Something went wrong looking up the roster: ${activeErr.message}`, ephemeral: true };
  }
  if (!activeRosters || activeRosters.length === 0) {
    return { content: `<@${targetDiscordId}> isn't currently signed to a franchise in this league.`, ephemeral: true };
  }
  if (activeRosters.length > 1) {
    // Shouldn't happen given the partial unique index, but if it does,
    // don't guess which one to release — surface it for manual cleanup.
    const seasons = activeRosters.map((r) => r.season).join(", ");
    console.error(
      `[release-driver] data integrity: driver ${driver.id} has ${activeRosters.length} active roster rows in league ${ctx.leagueId} (seasons: ${seasons}) — unique index should have prevented this.`
    );
    return {
      content: `<@${targetDiscordId}> has more than one active roster row in this league (seasons: ${seasons}). This shouldn't be possible — needs manual DB cleanup before releasing.`,
      ephemeral: true,
    };
  }

  const activeRoster = activeRosters[0];
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
  // place. Keyed off the roster row's actual stored season, not the
  // caller's input, so it still works if the caller omitted season.
  const { error: contractReleaseError } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .update({ status: "released", released_at: releasedAt, released_reason: reason })
    .eq("driver_id", driver.id)
    .eq("franchise_id", activeRoster.franchise_id)
    .eq("league_id", ctx.leagueId)
    .eq("season_start", activeRoster.season)
    .eq("status", "active");
  if (contractReleaseError) {
    console.error("[release-driver] driver_contracts release update failed (non-fatal):", contractReleaseError);
  }

  // NOTE: no wallet refund on release for event-economy leagues. Nothing
  // in league_event_economy_rules currently defines a release/buyout
  // credit, so a released driver's signing cost stays spent. Revisit if
  // HRL confirms a refund or dead-cap rule should apply here.

  const mismatchNote =
    seasonNote && seasonNote !== activeRoster.season
      ? ` (note: you said season ${seasonNote}, actual signed season was ${activeRoster.season})`
      : "";

  return {
    content: `Released <@${targetDiscordId}> from season ${activeRoster.season}${reason ? ` (${reason})` : ""}.${mismatchNote}`,
    ephemeral: false,
  };
});
