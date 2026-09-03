// cap.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

type FranchiseMatch = {
  id: string;
  name: string;
  abbreviation: string | null;
};

async function resolveFranchise(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  query: string
): Promise<{ franchise?: FranchiseMatch; error?: string }> {
  const { data, error } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation")
    .eq("league_id", leagueId)
    .or(`name.ilike.%${query}%,abbreviation.ilike.%${query}%`);

  if (error) {
    console.error("[cap] franchise lookup failed:", error);
    return { error: `Couldn't look up that franchise: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { error: `No franchise matching "${query}" in this league.` };
  }
  if (data.length > 1) {
    const names = data.map((f) => f.name).join(", ");
    return {
      error: `That matches more than one franchise: ${names}. Be more specific (e.g. include the season, like "McLaren 26").`,
    };
  }
  return { franchise: data[0] };
}

// Resolves the franchise the calling user currently drives for, used when
// /cap view is run with no franchise argument.
async function resolveOwnFranchise(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  discordUserId: string
): Promise<{ franchise?: FranchiseMatch; error?: string }> {
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordUserId)
    .maybeSingle();

  if (!driver) {
    return { error: "No driver record found for you — specify a franchise instead." };
  }

  const { data: roster } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("franchise_id")
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .is("released_at", null)
    .maybeSingle();

  if (!roster) {
    return { error: "You're not currently on a franchise roster in this league — specify a franchise instead." };
  }

  const { data: franchise } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation")
    .eq("id", roster.franchise_id)
    .maybeSingle();

  if (!franchise) {
    return { error: "Couldn't resolve your franchise record." };
  }

  return { franchise };
}

type CapSummary = {
  franchiseId: string;
  franchiseName: string;
  startingWallet: number | null;
  storedBalance: number | null;
  computedSpend: number;
  computedRemaining: number | null;
  driverCount: number;
  seasonsOverSoftCap: number;
  capFreezeActive: boolean;
  balanceDrift: boolean;
};

// Cap usage is computed from active driver_contracts.contract_value
// rather than trusting franchise_wallets.balance, since that field isn't
// reliably decremented outside the normal signing flow (see steward
// chat note — every wallet in HRL currently reads full starting_wallet
// regardless of active contracts). balanceDrift flags when the two
// disagree by more than a cent, so a steward can catch it either way.
async function buildCapSummary(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  franchiseId: string,
  franchiseName: string
): Promise<CapSummary> {
  const { data: contracts } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select("contract_value")
    .eq("league_id", leagueId)
    .eq("franchise_id", franchiseId)
    .eq("status", "active");

  const computedSpend = (contracts ?? []).reduce(
    (sum, c) => sum + (Number(c.contract_value) || 0),
    0
  );

  const { data: wallet } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("starting_wallet, balance, seasons_over_soft_cap, cap_freeze_active")
    .eq("league_id", leagueId)
    .eq("franchise_id", franchiseId)
    .maybeSingle();

  const startingWallet = wallet ? Number(wallet.starting_wallet) : null;
  const storedBalance = wallet ? Number(wallet.balance) : null;
  const computedRemaining = startingWallet !== null ? startingWallet - computedSpend : null;
  const balanceDrift =
    storedBalance !== null &&
    computedRemaining !== null &&
    Math.abs(storedBalance - computedRemaining) > 0.01;

  return {
    franchiseId,
    franchiseName,
    startingWallet,
    storedBalance,
    computedSpend,
    computedRemaining,
    driverCount: contracts?.length ?? 0,
    seasonsOverSoftCap: wallet?.seasons_over_soft_cap ?? 0,
    capFreezeActive: wallet?.cap_freeze_active ?? false,
    balanceDrift,
  };
}

function fmtMoney(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

function formatCapSummary(s: CapSummary): string {
  const lines = [
    `**${s.franchiseName}** — Salary Cap`,
    s.startingWallet !== null
      ? `Cap: ${fmtMoney(s.startingWallet)} | Spent: ${fmtMoney(s.computedSpend)} | Remaining: ${fmtMoney(s.computedRemaining)}`
      : `No wallet record found for this franchise — cap unknown. Spent (from contracts): ${fmtMoney(s.computedSpend)}`,
    `Active contracts: ${s.driverCount}`,
    s.capFreezeActive ? "🧊 Cap freeze is currently active for this franchise." : null,
    s.seasonsOverSoftCap > 0 ? `⚠️ Over soft cap for ${s.seasonsOverSoftCap} season(s).` : null,
    s.balanceDrift
      ? `⚠️ Stored wallet balance (${fmtMoney(s.storedBalance)}) doesn't match cap-minus-contracts (${fmtMoney(s.computedRemaining)}) — wallet may be stale.`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

registerCommand("cap_view", async (ctx) => {
  const supabase = createAdminClient();
  const query = ctx.options.franchise as string | undefined;

  const resolved = query
    ? await resolveFranchise(supabase, ctx.leagueId, query)
    : await resolveOwnFranchise(supabase, ctx.leagueId, ctx.discordUserId);

  if (resolved.error || !resolved.franchise) {
    return { content: resolved.error ?? "Couldn't resolve a franchise.", ephemeral: true };
  }

  const summary = await buildCapSummary(
    supabase,
    ctx.leagueId,
    resolved.franchise.id,
    resolved.franchise.name
  );

  return { content: formatCapSummary(summary), ephemeral: true };
});

// Gated on driver_leagues.is_owner / is_co_owner rather than
// leagues.commissioner_id, to match the "owner/co-owner only" language
// already used in kick/ban/lockdown's command descriptions.
async function requireLeagueOwner(ctx: {
  leagueId: string;
  discordUserId: string;
}): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();

  if (!driver) return "Only the league owner or co-owner can do that.";

  const { data: role } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_owner, is_co_owner")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (!role?.is_owner && !role?.is_co_owner) {
    return "Only the league owner or co-owner can do that.";
  }
  return null;
}

registerCommand("cap_edit", async (ctx) => {
  const denied = await requireLeagueOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const query = ctx.options.franchise as string | undefined;
  const amount = ctx.options.amount as number | undefined;

  if (!query) {
    return { content: "Specify a franchise.", ephemeral: true };
  }
  if (amount === undefined || amount < 0) {
    return { content: "Specify a valid cap amount.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const resolved = await resolveFranchise(supabase, ctx.leagueId, query);
  if (resolved.error || !resolved.franchise) {
    return { content: resolved.error ?? "Couldn't resolve a franchise.", ephemeral: true };
  }

  const { data: existingWallet } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("id, starting_wallet")
    .eq("league_id", ctx.leagueId)
    .eq("franchise_id", resolved.franchise.id)
    .maybeSingle();

  if (!existingWallet) {
    return {
      content: `${resolved.franchise.name} doesn't have a wallet record yet in this league — set one up before editing its cap.`,
      ephemeral: true,
    };
  }

  const previousCap = Number(existingWallet.starting_wallet);

  const { error } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .update({ starting_wallet: amount })
    .eq("id", existingWallet.id);

  if (error) {
    console.error("[cap_edit] update failed:", error);
    return { content: `Couldn't update the cap: ${error.message}`, ephemeral: true };
  }

  return {
    content: `Updated **${resolved.franchise.name}**'s salary cap: ${fmtMoney(previousCap)} → ${fmtMoney(amount)}.`,
    ephemeral: false,
  };
});

registerCommand("cap_league", async (ctx) => {
  const supabase = createAdminClient();

  const { data: wallets, error } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, division")
    .eq("league_id", ctx.leagueId);

  if (error) {
    console.error("[cap_league] wallet query failed:", error);
    return { content: `Couldn't load the league cap summary: ${error.message}`, ephemeral: true };
  }

  if (!wallets || wallets.length === 0) {
    return { content: "No franchise wallets found for this league.", ephemeral: true };
  }

  const { data: franchises } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name")
    .in(
      "id",
      wallets.map((w) => w.franchise_id)
    );
  const nameById = new Map((franchises ?? []).map((f) => [f.id, f.name]));

  const summaries = await Promise.all(
    wallets.map((w) =>
      buildCapSummary(supabase, ctx.leagueId, w.franchise_id, nameById.get(w.franchise_id) ?? w.franchise_id)
    )
  );

  // Group by whatever's in franchise_wallets.division (car-class label
  // like F1_26 in this league, not the D1/D2 competitive division — see
  // the cap.ts file header note).
  const byDivision = new Map<string, typeof summaries>();
  wallets.forEach((w, i) => {
    const key = w.division ?? "Unassigned";
    const list = byDivision.get(key) ?? [];
    list.push(summaries[i]);
    byDivision.set(key, list);
  });

  const leagueTotalCap = summaries.reduce((sum, s) => sum + (s.startingWallet ?? 0), 0);
  const leagueTotalSpend = summaries.reduce((sum, s) => sum + s.computedSpend, 0);
  const leagueTotalRemaining = leagueTotalCap - leagueTotalSpend;
  const overCapCount = summaries.filter(
    (s) => s.computedRemaining !== null && s.computedRemaining < 0
  ).length;
  const freezeCount = summaries.filter((s) => s.capFreezeActive).length;
  const driftCount = summaries.filter((s) => s.balanceDrift).length;

  const divisionLines = [...byDivision.entries()].map(([division, divSummaries]) => {
    const divCap = divSummaries.reduce((sum, s) => sum + (s.startingWallet ?? 0), 0);
    const divSpend = divSummaries.reduce((sum, s) => sum + s.computedSpend, 0);
    return `**${division}** — ${divSummaries.length} franchises — ${fmtMoney(divSpend)} / ${fmtMoney(divCap)} spent`;
  });

  const lines = [
    `**League Salary Cap Summary**`,
    `Total: ${fmtMoney(leagueTotalSpend)} / ${fmtMoney(leagueTotalCap)} (${fmtMoney(leagueTotalRemaining)} remaining across ${summaries.length} franchises)`,
    overCapCount > 0 ? `⚠️ ${overCapCount} franchise(s) currently over cap.` : null,
    freezeCount > 0 ? `🧊 ${freezeCount} franchise(s) with an active cap freeze.` : null,
    driftCount > 0
      ? `⚠️ ${driftCount} franchise(s) where stored wallet balance doesn't match cap-minus-contracts — run \`/cap board\` to see which.`
      : null,
    "",
    ...divisionLines,
  ].filter((l) => l !== null);

  return { content: lines.join("\n"), ephemeral: false };
});

registerCommand("cap_board", async (ctx) => {
  const supabase = createAdminClient();
  const divisionFilter = ctx.options.division as string | undefined;

  let walletQuery = supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, division")
    .eq("league_id", ctx.leagueId);

  if (divisionFilter) {
    walletQuery = walletQuery.ilike("division", `%${divisionFilter}%`);
  }

  const { data: wallets, error } = await walletQuery;

  if (error) {
    console.error("[cap_board] wallet query failed:", error);
    return { content: `Couldn't load cap board: ${error.message}`, ephemeral: true };
  }

  if (!wallets || wallets.length === 0) {
    return {
      content: divisionFilter
        ? `No franchises found for division matching "${divisionFilter}" in this league.`
        : "No franchise wallets found for this league.",
      ephemeral: true,
    };
  }

  const { data: franchises } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name")
    .in(
      "id",
      wallets.map((w) => w.franchise_id)
    );

  const nameById = new Map((franchises ?? []).map((f) => [f.id, f.name]));

  const summaries = await Promise.all(
    wallets.map((w) =>
      buildCapSummary(supabase, ctx.leagueId, w.franchise_id, nameById.get(w.franchise_id) ?? w.franchise_id)
    )
  );

  // Teams closest to (or over) their cap first — most actionable view for
  // a steward or commissioner checking compliance.
  summaries.sort((a, b) => (a.computedRemaining ?? Infinity) - (b.computedRemaining ?? Infinity));

  const lines = summaries.map((s) => {
    const flag = s.balanceDrift ? " ⚠️" : "";
    const freeze = s.capFreezeActive ? " 🧊" : "";
    return `**${s.franchiseName}** — ${fmtMoney(s.computedSpend)} / ${fmtMoney(s.startingWallet)} (${fmtMoney(s.computedRemaining)} left, ${s.driverCount} contracts)${freeze}${flag}`;
  });

  const header = divisionFilter
    ? `**Salary Cap Board — ${divisionFilter}**`
    : `**Salary Cap Board**`;

  return { content: [header, ...lines].join("\n"), ephemeral: false };
});
