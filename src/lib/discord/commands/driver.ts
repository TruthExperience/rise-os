import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";
import {
  getLeagueCapConfig,
  LeagueNotConfiguredError,
  type LeagueFinancialConfig,
} from "@/lib/pitboss/financial-engine";

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

/** Letters and digits only: "F2 25", "f2-25" and "F2_25" all become "f225". */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type FranchiseRow = {
  id: string;
  name: string;
  abbreviation: string | null;
  division: string | null;
};

async function resolveFranchise(leagueId: string, input: string) {
  const supabase = createAdminClient();

  const wanted = squash(input);
  if (!wanted) {
    return { error: "Name a franchise to sign the driver to." } as const;
  }

  const { data, error } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division")
    .eq("league_id", leagueId);

  if (error) return { error: error.message } as const;

  const rows = (data ?? []) as FranchiseRow[];
  const notFound = {
    error: `No franchise matching "${input}" found in this league.`,
  } as const;
  if (rows.length === 0) return notFound;

  // F2 grids reuse the same team names and abbreviations in every division
  // (AIX Racing, ART Grand Prix, …), so the name alone cannot pick one and
  // there was previously no way to sign anyone there at all. Each franchise
  // is matched on its name, its abbreviation, and either of those followed by
  // its division, so "AIX Racing F2_25" / "AIX F2_25" means exactly one
  // franchise while plain "AIX Racing" still reports the ambiguity.
  const aliasesOf = (f: FranchiseRow) => [
    squash(f.name),
    squash(f.abbreviation ?? ""),
    squash(`${f.name} ${f.division ?? ""}`),
    squash(`${f.abbreviation ?? ""} ${f.division ?? ""}`),
  ];

  const matches = rows.filter((f) => aliasesOf(f).some((alias) => alias.includes(wanted)));
  if (matches.length === 0) return notFound;

  if (matches.length > 1) {
    // An exact "name + division" match wins outright. Otherwise refuse, and
    // say which divisions the name exists in and how to name one of them.
    const exact = matches.filter((f) => squash(`${f.name} ${f.division ?? ""}`) === wanted);
    if (exact.length === 1) return { franchise: exact[0] } as const;

    const names = matches
      .map((f) => `${f.name} (${f.division ?? "no division"})`)
      .join(", ");
    const example = matches[0].division
      ? `${matches[0].name} ${matches[0].division}`
      : matches[0].name;
    return {
      error: `"${input}" matches more than one franchise: ${names}. Add the division to pick one, e.g. "${example}".`,
    } as const;
  }

  return { franchise: matches[0] } as const;
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

// Resolves the cap config that applies to a signing. The franchise's own
// division is authoritative: if we can't find a config for it, the signing is
// refused rather than priced against some other division's cap. The
// league-level fallback exists only for leagues that leave
// rise_os.franchises.division null and keep a single config for the whole
// league (W11) — never as a rescue for a division that IS set.
async function resolveFinancialConfig(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  franchiseDivision: string | null
): Promise<LeagueFinancialConfig | null> {
  if (franchiseDivision) {
    try {
      return await getLeagueCapConfig(supabase, leagueId, franchiseDivision);
    } catch (err) {
      if (!(err instanceof LeagueNotConfiguredError)) throw err;
      throw new Error(
        `No financial config exists for this franchise's division ("${franchiseDivision}"), so there's no cap or DDV band to sign against. Add a league_financial_config row for it — signing is blocked rather than priced against another division's numbers.`
      );
    }
  }

  const { data, error } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("*")
    .eq("league_id", leagueId);

  if (error) {
    throw new Error(`Failed to fetch league_financial_config: ${error.message}`);
  }

  const rows = (data ?? []) as LeagueFinancialConfig[];
  if (rows.length === 0) return null; // no cap model — event-economy league
  if (rows.length === 1) return rows[0];

  throw new Error(
    `This league has ${rows.length} financial configs (${rows
      .map((r) => r.division)
      .join(", ")}) and this franchise has no division, so there's no way to tell which cap applies. Set the franchise's division before signing.`
  );
}

// Discord options arrive as strings or numbers depending on how the command was
// declared upstream, so every financial option goes through these.
function parseAmountOption(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.replace(/[,\s$]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseScheduleOption(raw: unknown): { schedule?: unknown; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return { schedule: raw };
  try {
    return { schedule: JSON.parse(raw) };
  } catch {
    return {
      error:
        'That bonus schedule isn\'t valid JSON — pass a keyed list like [{"key":"race_win","amount":30000}] or use bonus_template.',
    };
  }
}

type ContractRpcResult = {
  ok?: boolean;
  errors?: unknown;
  contract_id?: string | null;
  ddv_basis?: number | string | null;
  floor?: number | string | null;
  ceiling?: number | string | null;
  flags?: unknown;
};

// A cap-model signing prepared by create_driver_contract's dry run, ready to
// commit once the roster row is written.
type PendingContract = {
  args: Record<string, unknown>;
  dry: ContractRpcResult;
  value: number;
  seasons: number;
  signingBonus: number;
  contractClass: string;
  valueSupplied: boolean;
};



// Deducts a signing's team_budget_delta from the franchise's wallet and
// logs the transaction. Event-economy leagues only — cap-model leagues
// charge the contract's per-season base through driver_contracts instead,
// they never call this. Added 2026-09-03: signing rules previously only set
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
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
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

  const franchiseResult = await resolveFranchise(leagueId, franchiseInput);
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
    .eq("league_id", leagueId)
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

  // Resolve the financial model before anything is written. A cap-model league
  // signs through pitboss.create_driver_contract — the same function /contract
  // create uses — so the DDV band, hard apron, per-season base schedule and
  // signing-bonus debit all apply in one place. The dry run comes first so a
  // refused deal leaves no half-signed roster row behind.
  let config: LeagueFinancialConfig | null;
  try {
    config = await resolveFinancialConfig(supabase, leagueId, franchise.division);
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : "Couldn't load this league's financial config.",
      ephemeral: true,
    };
  }

  const financialNotes: string[] = [];
  let pendingContract: PendingContract | null = null;

  if (config) {
    const division = franchise.division ?? config.division;
    const schedule = parseScheduleOption(ctx.options.bonus_schedule);
    if (schedule.error) {
      return { content: schedule.error, ephemeral: true };
    }

    const rawValue = ctx.options.value ?? ctx.options.contract_value;
    const suppliedValue = parseAmountOption(rawValue);
    if (
      rawValue !== undefined &&
      rawValue !== null &&
      rawValue !== "" &&
      suppliedValue === null
    ) {
      return {
        content: "That contract value isn't a usable amount — give a number greater than zero.",
        ephemeral: true,
      };
    }

    const parsedSeasons = parseAmountOption(ctx.options.seasons ?? ctx.options.contract_seasons);
    const seasons = parsedSeasons && parsedSeasons >= 1 ? Math.floor(parsedSeasons) : 1;
    const signingBonus = parseAmountOption(ctx.options.signing_bonus) ?? 0;

    // No value given: price the deal on the same DDV basis the contract
    // function will measure, so it lands exactly on the floor instead of being
    // refused. A driver with no DDV row is seeded at the division's
    // ddv_starting by create_driver_contract, so that is the basis there.
    let ddvBasis = Number(config.ddv_starting);
    const { data: ddvRow, error: ddvError } = await supabase
      .schema("pitboss")
      .from("driver_ddv")
      .select("current_ddv")
      .eq("league_id", leagueId)
      .eq("driver_id", driver.id)
      .maybeSingle();
    if (ddvError) {
      return { content: `Couldn't read that driver's DDV: ${ddvError.message}`, ephemeral: true };
    }
    if (ddvRow) {
      const { data: rolling } = await supabase
        .schema("pitboss")
        .rpc("rolling_ddv", { p_driver: driver.id, p_league: leagueId, p_window: 3 });
      if (rolling !== null && rolling !== undefined) ddvBasis = Number(rolling);
    }

    const contractValue = suppliedValue ?? ddvBasis * Number(config.contract_floor_pct);
    const contractClass = tierInput ? tierInput.toUpperCase() : "T1";

    const args: Record<string, unknown> = {
      p_driver: driver.id,
      p_league: leagueId,
      p_franchise: franchise.id,
      p_division: division,
      p_season_start: season,
      p_seasons: seasons,
      p_value: contractValue,
      p_contract_class: contractClass,
      p_tier: tierInput || null,
      p_signing_bonus: signingBonus,
      p_actor: ctx.discordUserId,
      p_bonus_schedule: schedule.schedule ?? null,
      p_template:
        typeof ctx.options.bonus_template === "string" ? ctx.options.bonus_template : null,
    };

    const { data: dryData, error: dryError } = await supabase
      .schema("pitboss")
      .rpc("create_driver_contract", { ...args, p_dry_run: true });
    if (dryError) {
      console.error("[sign-driver] create_driver_contract dry run failed:", dryError);
      return { content: `Couldn't check the contract: ${dryError.message}`, ephemeral: true };
    }

    const dry = (dryData ?? {}) as ContractRpcResult;
    if (!dry.ok) {
      const errors = Array.isArray(dry.errors) ? dry.errors.join(" ") : "The contract was refused.";
      return { content: `Signing blocked. ${errors}`, ephemeral: true };
    }

    pendingContract = {
      args,
      dry,
      value: contractValue,
      seasons,
      signingBonus,
      contractClass,
      valueSupplied: suppliedValue !== null,
    };
  }

  const { error: membershipUpsertError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .upsert(
      { driver_id: driver.id, league_id: leagueId, is_driver: true },
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
      league_id: leagueId,
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

  // Branch on financial model: a cap-model league writes its contract through
  // create_driver_contract, the same function /contract create uses, so the
  // per-season base schedule and the signing-bonus debit actually apply. An
  // event-economy league (e.g. HRL, rows in league_event_economy_rules
  // instead) gets driver_leagues.market_value set from the matching
  // signing_<tier> rule, AND a wallet deduction if that rule also carries a
  // team_budget_delta. A league with neither just gets the roster record
  // above and nothing financial — that's a legitimate state, not an error,
  // since not every league has set up its economy yet.
  if (pendingContract) {
    const { args, dry, value, seasons, signingBonus, contractClass, valueSupplied } =
      pendingContract;

    const { data: createdData, error: contractError } = await supabase
      .schema("pitboss")
      .rpc("create_driver_contract", { ...args, p_dry_run: false });
    const created = (createdData ?? {}) as ContractRpcResult;

    if (contractError) {
      console.error("[sign-driver] create_driver_contract failed:", contractError);
      financialNotes.push(
        `Roster saved, but the contract could not be created: ${contractError.message}. Needs manual follow-up.`
      );
    } else if (!created.ok) {
      const errors = Array.isArray(created.errors) ? created.errors.join(" ") : "unknown refusal";
      console.error("[sign-driver] create_driver_contract refused after a passing dry run:", errors);
      financialNotes.push(
        `Roster saved, but the contract was refused: ${errors} Needs manual follow-up.`
      );
    } else {
      const flags = Array.isArray(created.flags)
        ? created.flags.filter((f): f is string => typeof f === "string")
        : [];
      const floor = Number(dry.floor ?? 0);
      const ceiling = Number(dry.ceiling ?? 0);

      let note =
        `Contract created (${contractClass}) at ${value.toLocaleString()}` +
        `${valueSupplied ? "" : " (no value given — priced at the league's DDV floor)"}` +
        ` for ${seasons} season(s) — DDV basis ${Number(dry.ddv_basis ?? 0).toLocaleString()},` +
        ` allowed band ${floor.toLocaleString()}–${ceiling.toLocaleString()}.`;

      if (flags.includes("ddv_seeded_at_starting_value")) {
        note += " No DDV was on file, so it was seeded at the division's starting value.";
      }
      if (flags.includes("over_soft_cap_luxury_tax_applies")) {
        note += " This deal takes the team over the soft cap.";
      }
      if (flags.includes("crrb_48h_review")) {
        note += " Flagged for the 48h CRRB review.";
      }

      if (signingBonus > 0) {
        let debited = false;
        if (created.contract_id) {
          const { data: debit } = await supabase
            .schema("pitboss")
            .from("wallet_transactions")
            .select("amount")
            .eq("related_id", created.contract_id)
            .eq("related_type", "contract")
            .eq("transaction_type", "contract_signing")
            .maybeSingle();
          debited = Boolean(debit);
        }
        note += debited
          ? ` Signing bonus ${signingBonus.toLocaleString()} debited from the team wallet.`
          : ` Signing bonus ${signingBonus.toLocaleString()} recorded, but this division has no wallet to debit.`;
      }

      financialNotes.push(note);
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
          .eq("league_id", leagueId)
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
            .eq("league_id", leagueId);
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
            leagueId,
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
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
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
    .eq("league_id", leagueId)
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
      `[release-driver] data integrity: driver ${driver.id} has ${activeRosters.length} active roster rows in league ${leagueId} (seasons: ${seasons}) — unique index should have prevented this.`
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
    .eq("league_id", leagueId)
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
