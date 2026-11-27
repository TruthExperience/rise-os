// src/app/pitboss/admin/cap-status/page.tsx — Franchise Cap Status (admin)
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/server";
import { leagueCurrencySymbol } from "@/lib/currency";
import { computeCapSpend, isCapSpendAdjustment } from "@/lib/pitboss/cap-spend";
import LeagueSelect from "./LeagueSelect";

// Live data on every request; must not be prerendered at build time.
export const dynamic = "force-dynamic";

// Used when no ?league= param is present (keeps old links showing TRL).
const DEFAULT_LEAGUE_ID = "3a005e8d-c35f-4a57-aa27-c59c0c3812e2"; // TRL

// Fallback when a league has no wallets at all, so the page still says which
// season it is reporting.
const FALLBACK_SEASON = "1";

// Defensive fallback if a league has no currency_code.
const FALLBACK_CURRENCY_CODE = "TRL";

type League = {
  id: string;
  name: string;
  slug: string;
  currency_code: string;
};

type Franchise = {
  id: string;
  name: string;
  abbreviation: string | null;
  // Nullable: some leagues (e.g. W11) have no division on the franchise row.
  division: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  gm_id: string | null;
};

type Wallet = {
  franchise_id: string;
  division: string | null;
  season: string | number | null;
  balance: number;
  starting_wallet: number;
  seasons_over_soft_cap: number | null;
  cap_freeze_active: boolean | null;
};

type CapConfig = {
  division: string;
  soft_cap: number;
  hard_apron: number;
};

type ContractRow = {
  franchise_id: string | null;
  contract_value: number | null;
  base_salary_per_season: unknown;
  season_start: string | null;
  season_end: string | null;
};

type LedgerRow = {
  franchise_id: string | null;
  transaction_type: string | null;
  related_type: string | null;
  amount: number | string | null;
};

// Labels for divisions whose code has no season suffix.
const KNOWN_DIVISION_LABELS: Record<string, string> = {
  F1: "F1 · 2026",
  F2: "F2",
};

function labelForDivision(division: string) {
  if (KNOWN_DIVISION_LABELS[division]) return KNOWN_DIVISION_LABELS[division];
  const match = division.match(/^(.+)_(\d{2})$/);
  if (match) return `${match[1]} · 20${match[2]}`;
  return division;
}

// Undated divisions first, then newest season suffix (_26, _25) first.
function divisionSortKey(division: string) {
  const match = division.match(/_(\d{2})$/);
  return match ? -Number(match[1]) : -9999;
}

// Wallets carry the season as text or number depending on the league; compare
// them as trimmed strings everywhere.
function seasonKey(value: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  return key === "" ? null : key;
}

// Every season the league actually has wallets for, newest first. The previous
// version hardcoded season 1, so VRC (wallets on season 2) and WSC (season 3)
// rendered as "no wallet on record" on a page that claimed they had none.
function availableSeasons(wallets: Wallet[]): string[] {
  const seen = new Set<string>();
  for (const w of wallets) {
    const key = seasonKey(w.season);
    if (key) seen.add(key);
  }
  return [...seen].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return nb - na;
    if (aNum) return -1;
    if (bNum) return 1;
    return b.localeCompare(a);
  });
}

// Prefix comes from the league's own currency: W11 is UK-based (£W11), TRL and
// WSC stay in dollars ($TRL, $WSC). See @/lib/currency.
function formatMoney(n: number, currencyCode: string, leagueSlug?: string) {
  const prefix = leagueCurrencySymbol(leagueSlug, `$${currencyCode}`);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
    .format(n)
    .replace("$", `${prefix} `);
}

async function getLeagues(): Promise<League[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug, currency_code")
    .eq("sport", "sim_racing")
    .in("pitboss_status", ["active", "trial"])
    .eq("is_public", true)
    .order("name");

  if (error) throw error;
  return (data ?? []) as League[];
}

async function getData(leagueId: string) {
  const supabase = createAdminClient();

  const { data: franchises, error: franchiseErr } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division, logo_url, primary_color, secondary_color, gm_id")
    .eq("league_id", leagueId)
    .order("division")
    .order("name");

  if (franchiseErr) throw franchiseErr;

  // Every season's wallets: the page picks one below, and the list of available
  // seasons comes from these same rows.
  const { data: wallets, error: walletErr } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select(
      "franchise_id, division, season, balance, starting_wallet, seasons_over_soft_cap, cap_freeze_active"
    )
    .eq("league_id", leagueId);

  if (walletErr) throw walletErr;

  const { data: caps, error: capErr } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("division, soft_cap, hard_apron")
    .eq("league_id", leagueId);

  if (capErr) throw capErr;

  // Spend is measured from active contracts' per-season bases plus ledger
  // adjustments, exactly as /cap view does — not from the wallet balance, which
  // only moves for signing bonuses.
  const { data: contracts, error: contractErr } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select("franchise_id, contract_value, base_salary_per_season, season_start, season_end")
    .eq("league_id", leagueId)
    .eq("status", "active");

  if (contractErr) throw contractErr;

  const { data: ledger, error: ledgerErr } = await supabase
    .schema("pitboss")
    .from("wallet_transactions")
    .select("franchise_id, transaction_type, related_type, amount")
    .eq("league_id", leagueId);

  if (ledgerErr) throw ledgerErr;

  return {
    franchises: (franchises ?? []) as Franchise[],
    wallets: (wallets ?? []) as Wallet[],
    caps: (caps ?? []) as CapConfig[],
    contracts: (contracts ?? []) as ContractRow[],
    ledger: (ledger ?? []) as LedgerRow[],
  };
}

// Team Principals by franchise id: pitboss.team_rosters.is_team_principal for
// the season, attributed to a franchise via the driver's active driver_contracts row.
async function getTeamPrincipals(leagueId: string, season: string): Promise<Map<string, string[]>> {
  const supabase = createAdminClient();

  const { data: tpRows, error: tpErr } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("driver_id")
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("is_team_principal", true);

  if (tpErr) throw tpErr;
  if (!tpRows || tpRows.length === 0) return new Map();

  const driverIds = tpRows.map((r) => r.driver_id);

  const { data: contracts, error: contractErr } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select("driver_id, franchise_id")
    .eq("league_id", leagueId)
    .eq("status", "active")
    .in("driver_id", driverIds);

  if (contractErr) throw contractErr;

  const { data: drivers, error: driverErr } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id, discord_username, display_name")
    .in("id", driverIds);

  if (driverErr) throw driverErr;

  const nameByDriverId = new Map(
    (drivers ?? []).map((d) => [d.id, d.display_name || d.discord_username])
  );

  const byFranchise = new Map<string, string[]>();
  for (const c of contracts ?? []) {
    if (!c.franchise_id) continue; // TP with no active contract this season — no franchise to attach to
    const name = nameByDriverId.get(c.driver_id);
    if (!name) continue;
    const existing = byFranchise.get(c.franchise_id) ?? [];
    existing.push(name);
    byFranchise.set(c.franchise_id, existing);
  }

  return byFranchise;
}

export default async function CapStatusPage({
  searchParams,
}: {
  searchParams: { league?: string; season?: string };
}) {
  const leagues = await getLeagues();

  const selected =
    leagues.find((l) => l.slug === searchParams.league) ??
    leagues.find((l) => l.id === DEFAULT_LEAGUE_ID) ??
    leagues[0];

  if (!selected) {
    return (
      <main className="min-h-screen bg-[#0C0D0F] p-10 text-[#EDEDEE]">
        No sim racing leagues found.
      </main>
    );
  }

  const currencyCode = selected.currency_code || FALLBACK_CURRENCY_CODE;

  const { franchises, wallets, caps, contracts, ledger } = await getData(selected.id);

  // Season comes from the league's own wallet rows (?season= overrides it), so
  // a league on season 2 or 3 shows its own season instead of an empty page.
  const seasons = availableSeasons(wallets);
  const requestedSeason = searchParams.season?.trim();
  const season =
    requestedSeason && seasons.includes(requestedSeason)
      ? requestedSeason
      : seasons[0] ?? FALLBACK_SEASON;

  const seasonWallets = wallets.filter((w) => seasonKey(w.season) === season);
  const teamPrincipals = await getTeamPrincipals(selected.id, season);

  const walletByFranchise = new Map(seasonWallets.map((w) => [w.franchise_id, w]));
  const capByDivision = new Map(caps.map((c) => [c.division, c]));

  const contractsByFranchise = new Map<string, ContractRow[]>();
  for (const c of contracts) {
    if (!c.franchise_id) continue;
    const list = contractsByFranchise.get(c.franchise_id) ?? [];
    list.push(c);
    contractsByFranchise.set(c.franchise_id, list);
  }

  const adjustmentsByFranchise = new Map<string, LedgerRow[]>();
  for (const row of ledger) {
    if (!row.franchise_id || !isCapSpendAdjustment(row)) continue;
    const list = adjustmentsByFranchise.get(row.franchise_id) ?? [];
    list.push(row);
    adjustmentsByFranchise.set(row.franchise_id, list);
  }

  // Franchise division, falling back to its wallet's division, then "Unassigned".
  const divisionOf = (f: Franchise): string =>
    f.division ?? walletByFranchise.get(f.id)?.division ?? "Unassigned";

  const divisionOrder = Array.from(new Set(franchises.map(divisionOf))).sort(
    (a, b) => divisionSortKey(a) - divisionSortKey(b) || a.localeCompare(b)
  );

  const byDivision = divisionOrder.map((division) => ({
    division,
    label: labelForDivision(division),
    cap: capByDivision.get(division),
    teams: franchises.filter((f) => divisionOf(f) === division),
  }));

  return (
    <main className="min-h-screen bg-[#0C0D0F] text-[#EDEDEE]">
      <header className="border-b border-[#232428] px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="text-sm tracking-wide text-[#8A8D93]">
            {selected.name} &middot; season {season}
          </p>
          <LeagueSelect leagues={leagues} selectedSlug={selected.slug} />
        </div>
        <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Franchise Cap Status</h1>
        <p className="mt-2 max-w-xl text-sm text-[#8A8D93]">
          Season {season} contract payroll against each division&rsquo;s Soft Cap and Hard
          Apron, per CRRB Financial Regulations v2.2.
        </p>

        {seasons.length > 0 && (
          <nav className="mt-4 flex flex-wrap items-center gap-2" aria-label="Season">
            <span className="text-xs uppercase tracking-wide text-[#8A8D93]">Season</span>
            {seasons.map((s) => {
              const active = s === season;
              return (
                <Link
                  key={s}
                  href={`/pitboss/admin/cap-status?league=${selected.slug}&season=${s}`}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "rounded-sm bg-[#1F2E22] px-3 py-1 text-sm text-[#7CC28A]"
                      : "rounded-sm border border-[#232428] bg-[#131417] px-3 py-1 text-sm text-[#8A8D93] hover:text-[#EDEDEE]"
                  }
                >
                  {s}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      <div className="mx-auto max-w-6xl px-6 py-10 sm:px-10">
        {byDivision.map((group) => (
          <section key={group.division} className="mb-14 last:mb-0">
            <div className="mb-5 flex items-baseline justify-between border-b border-[#232428] pb-3">
              <h2 className="text-lg font-medium">{group.label}</h2>
              {group.cap ? (
                <p className="text-sm text-[#8A8D93]">
                  Soft cap {formatMoney(group.cap.soft_cap, currencyCode, selected.slug)} &middot; Hard apron{" "}
                  {formatMoney(group.cap.hard_apron, currencyCode, selected.slug)}
                </p>
              ) : (
                <p className="text-sm text-[#8A8D93]">Uncapped</p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.teams.map((team) => {
                const wallet = walletByFranchise.get(team.id);
                const cap = group.cap;
                const teamContracts = contractsByFranchise.get(team.id) ?? [];
                const spend = wallet
                  ? computeCapSpend({
                      contracts: teamContracts,
                      walletSeason: season,
                      adjustments: adjustmentsByFranchise.get(team.id) ?? [],
                      startingWallet: Number(wallet.starting_wallet),
                      storedBalance: Number(wallet.balance),
                    })
                  : null;
                const softCapPct =
                  cap && spend
                    ? Math.min(100, (spend.computedSpend / cap.soft_cap) * 100)
                    : 0;
                const accent = team.primary_color ?? "#3A3C42";
                const tpNames = teamPrincipals.get(team.id);

                return (
                  <article
                    key={team.id}
                    className="rounded-md border border-[#232428] bg-[#131417] p-5"
                    style={{ borderLeftColor: accent, borderLeftWidth: "3px" }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        {team.logo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={team.logo_url}
                            alt=""
                            className="h-8 w-8 object-contain"
                          />
                        ) : (
                          <div
                            className="flex h-8 w-8 items-center justify-center rounded-sm text-xs font-medium"
                            style={{ backgroundColor: accent + "22", color: accent }}
                          >
                            {team.abbreviation ?? "—"}
                          </div>
                        )}
                        <h3 className="text-sm font-medium leading-tight">
                          {team.name}
                        </h3>
                      </div>

                      {tpNames && tpNames.length > 0 ? (
                        <span className="shrink-0 rounded-sm bg-[#1F2E22] px-2 py-0.5 text-[11px] text-[#7CC28A]">
                          {tpNames.join(", ")}
                        </span>
                      ) : (
                        !team.gm_id && (
                          <span className="shrink-0 rounded-sm bg-[#3A2A1F] px-2 py-0.5 text-[11px] text-[#E8A25C]">
                            No GM
                          </span>
                        )
                      )}
                    </div>

                    {wallet && spend ? (
                      <div className="mt-4">
                        <div className="flex items-baseline justify-between text-sm">
                          <span className="text-[#8A8D93]">Spent</span>
                          <span className="tabular-nums font-medium">
                            {formatMoney(spend.computedSpend, currencyCode, selected.slug)}
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#232428]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${softCapPct}%`,
                              backgroundColor: accent,
                            }}
                          />
                        </div>
                        <p className="mt-1.5 text-[11px] text-[#8A8D93]">
                          {cap
                            ? `${formatMoney(spend.computedSpend, currencyCode, selected.slug)} spent of ${formatMoney(cap.soft_cap, currencyCode, selected.slug)} soft cap`
                            : `${formatMoney(spend.computedSpend, currencyCode, selected.slug)} spent · uncapped`}
                          {spend.computedRemaining !== null && (
                            <>
                              {" · "}
                              <span
                                className={
                                  spend.computedRemaining < 0 ? "text-[#E8735C]" : undefined
                                }
                              >
                                {formatMoney(spend.computedRemaining, currencyCode, selected.slug)} remaining
                              </span>
                            </>
                          )}
                        </p>
                        <p className="mt-1 text-[11px] text-[#8A8D93]">
                          {teamContracts.length} active contract
                          {teamContracts.length === 1 ? "" : "s"}
                          {wallet.cap_freeze_active ? " · 🧊 cap freeze active" : ""}
                          {(wallet.seasons_over_soft_cap ?? 0) > 0
                            ? ` · ⚠ over soft cap ${wallet.seasons_over_soft_cap} season(s)`
                            : ""}
                        </p>
                        {spend.balanceDrift && (
                          <p className="mt-1 text-[11px] text-[#E8A25C]">
                            ⚠ Wallet balance ({formatMoney(Number(wallet.balance), currencyCode, selected.slug)})
                            doesn&rsquo;t match cap-minus-spend (
                            {formatMoney(spend.computedRemaining ?? 0, currencyCode, selected.slug)}) — wallet
                            may be stale.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-[#8A8D93]">
                        No wallet on record for season {season}.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
