// src/app/pitboss/admin/cap-status/page.tsx
//
// Franchise Cap Status — sits alongside your other flat admin tools
// (rulebooks, appeals, cert, drivers, incidents, licences, penalties,
// results, setups, standings, steward) under /pitboss/admin.
//
// UPDATED 2026-09-02: added a league chooser (?league=<slug>). The page
// no longer hardcodes TRL — it looks up the league by slug, then derives
// divisions from whatever's actually present in rise_os.franchises for
// that league, instead of a fixed DIVISION_ORDER/DIVISION_LABELS list.
// This matters because not every league uses TRL's cap model: HRL (and
// any future league) may have zero rows in pitboss.league_financial_config,
// so the cap line / progress bar is rendered conditionally per division
// and simply omitted when no config exists, rather than assuming it does.
//
// Confirmed against src/lib/supabase/server.ts and src/lib/getAuthedDriver.ts
// (getAuthedDriver already uses this exact factory + .schema('pitboss')
// pattern for a non-public-schema admin query — same approach here).
import { createAdminClient } from "@/lib/supabase/server";
import LeagueSelect from "./LeagueSelect";

// Required: this page fetches live wallet/cap data on every request and
// must not be statically prerendered at build time. Without this, the
// build fails with "Dynamic server usage: no-store fetch" during
// prerendering — confirmed as the actual cause of the two failed
// production deployments on 2026-09-02.
export const dynamic = "force-dynamic";

const DEFAULT_LEAGUE_SLUG = "trl";
const SEASON = "1";

type League = {
  id: string;
  name: string;
  slug: string;
};

type Franchise = {
  id: string;
  name: string;
  abbreviation: string | null;
  division: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  gm_id: string | null;
};

type Wallet = {
  franchise_id: string;
  balance: number;
  starting_wallet: number;
};

type CapConfig = {
  division: string;
  soft_cap: number;
  hard_apron: number;
};

function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
    .format(n)
    .replace("$", "$TRL ");
}

// Turns a division code into a display label without needing a
// per-league hardcoded map. "F1" -> "F1 · Current", "F1_25" -> "F1 · 2025",
// "F2_24" -> "F2 · 2024". Falls back to the raw code if it doesn't match
// the "<PREFIX>_<YY>" shape.
function labelForDivision(division: string) {
  const match = division.match(/^([A-Za-z0-9]+)_(\d{2})$/);
  if (match) {
    const [, prefix, yy] = match;
    return `${prefix} · 20${yy}`;
  }
  return `${division} · Current`;
}

async function getLeagues(): Promise<League[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug")
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

  const { data: wallets, error: walletErr } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, balance, starting_wallet")
    .eq("league_id", leagueId)
    .eq("season", SEASON);

  if (walletErr) throw walletErr;

  // Not every league has a row here — leagues with a different economic
  // model (e.g. HRL's per-race ledger) legitimately return zero rows.
  // That's expected, not an error.
  const { data: caps, error: capErr } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("division, soft_cap, hard_apron")
    .eq("league_id", leagueId);

  if (capErr) throw capErr;

  return {
    franchises: (franchises ?? []) as Franchise[],
    wallets: (wallets ?? []) as Wallet[],
    caps: (caps ?? []) as CapConfig[],
  };
}

export default async function CapStatusPage({
  searchParams,
}: {
  searchParams?: { league?: string };
}) {
  const leagues = await getLeagues();

  const requestedSlug = searchParams?.league ?? DEFAULT_LEAGUE_SLUG;
  const selectedLeague =
    leagues.find((l) => l.slug === requestedSlug) ??
    leagues.find((l) => l.slug === DEFAULT_LEAGUE_SLUG) ??
    leagues[0];

  if (!selectedLeague) {
    return (
      <main className="min-h-screen bg-[#0C0D0F] px-6 py-10 text-[#EDEDEE]">
        No leagues found.
      </main>
    );
  }

  const { franchises, wallets, caps } = await getData(selectedLeague.id);

  const walletByFranchise = new Map(wallets.map((w) => [w.franchise_id, w]));
  const capByDivision = new Map(caps.map((c) => [c.division, c]));

  // Divisions come from whatever's actually on the franchises, not a
  // fixed list — sorted alphabetically, which happens to put "current"
  // codes (F1) ahead of dated ones (F1_25, F1_26) and earlier years
  // ahead of later ones for dated codes.
  const divisionsPresent = Array.from(
    new Set(franchises.map((f) => f.division).filter((d): d is string => Boolean(d)))
  ).sort();

  const byDivision = divisionsPresent.map((division) => ({
    division,
    label: labelForDivision(division),
    cap: capByDivision.get(division),
    teams: franchises.filter((f) => f.division === division),
  }));

  const unassigned = franchises.filter((f) => !f.division);

  return (
    <main className="min-h-screen bg-[#0C0D0F] text-[#EDEDEE]">
      <header className="border-b border-[#232428] px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm tracking-wide text-[#8A8D93]">{selectedLeague.name}</p>
            <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Franchise Cap Status</h1>
            <p className="mt-2 max-w-xl text-sm text-[#8A8D93]">
              Live wallet balances against each division&rsquo;s Soft Cap and
              Hard Apron, where the league defines one. Leagues on a
              different financial model are shown without cap figures.
            </p>
          </div>
          <LeagueSelect leagues={leagues} selectedSlug={selectedLeague.slug} />
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-10 sm:px-10">
        {byDivision.length === 0 && (
          <p className="text-sm text-[#8A8D93]">
            No franchises found for {selectedLeague.name}.
          </p>
        )}

        {byDivision.map((group) => (
          <section key={group.division} className="mb-14 last:mb-0">
            <div className="mb-5 flex items-baseline justify-between border-b border-[#232428] pb-3">
              <h2 className="text-lg font-medium">{group.label}</h2>
              {group.cap && (
                <p className="text-sm text-[#8A8D93]">
                  Soft cap {formatMoney(group.cap.soft_cap)} &middot; Hard apron{" "}
                  {formatMoney(group.cap.hard_apron)}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.teams.map((team) => {
                const wallet = walletByFranchise.get(team.id);
                const cap = group.cap;
                const spend = wallet
                  ? wallet.starting_wallet - wallet.balance
                  : 0;
                const softCapPct = cap
                  ? Math.min(100, (spend / cap.soft_cap) * 100)
                  : 0;
                const accent = team.primary_color ?? "#3A3C42";

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
                      {!team.gm_id && (
                        <span className="shrink-0 rounded-sm bg-[#3A2A1F] px-2 py-0.5 text-[11px] text-[#E8A25C]">
                          No GM
                        </span>
                      )}
                    </div>

                    {cap ? (
                      wallet ? (
                        <div className="mt-4">
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="text-[#8A8D93]">Wallet</span>
                            <span className="tabular-nums font-medium">
                              {formatMoney(wallet.balance)}
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
                            {formatMoney(spend)} spent of {formatMoney(cap.soft_cap)} soft cap
                          </p>
                        </div>
                      ) : (
                        <p className="mt-4 text-sm text-[#8A8D93]">
                          No wallet on record for season {SEASON}.
                        </p>
                      )
                    ) : (
                      <p className="mt-4 text-sm text-[#8A8D93]">
                        No cap data for this league.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}

        {unassigned.length > 0 && (
          <section className="mb-14 last:mb-0">
            <div className="mb-5 flex items-baseline justify-between border-b border-[#232428] pb-3">
              <h2 className="text-lg font-medium">Unassigned division</h2>
              <p className="text-sm text-[#8A8D93]">{unassigned.length} franchises</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {unassigned.map((team) => (
                <article
                  key={team.id}
                  className="rounded-md border border-[#232428] bg-[#131417] p-5"
                >
                  <h3 className="text-sm font-medium leading-tight">{team.name}</h3>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
