// src/app/pitboss/admin/cap-status/page.tsx
//
// Franchise Cap Status — sits alongside your other flat admin tools
// (rulebooks, appeals, cert, drivers, incidents, licences, penalties,
// results, setups, standings, steward) under /pitboss/admin.
//
// ASSUMPTION: src/lib/supabase/admin.ts exports a function that returns a
// service-role Supabase client, e.g. `export function createAdminClient() {...}`.
// If the actual export name/shape differs (default export, singleton instance,
// etc.), adjust the import + call on the next two lines only — nothing else
// in this file depends on the exact signature beyond `.schema(x).from(y)`.
import { createAdminClient } from "@/lib/supabase/admin";

const LEAGUE_ID = "3a005e8d-c35f-4a57-aa27-c59c0c3812e2"; // TRL
const SEASON = "1";

type Franchise = {
  id: string;
  name: string;
  abbreviation: string | null;
  division: string;
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

const DIVISION_LABELS: Record<string, string> = {
  F1: "F1 · 2026",
  F1_25: "F1 · 2025",
  F2: "F2",
};

const DIVISION_ORDER = ["F1", "F1_25", "F2"];

function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
    .format(n)
    .replace("$", "$TRL ");
}

async function getData() {
  const supabase = createAdminClient();

  const { data: franchises, error: franchiseErr } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division, logo_url, primary_color, secondary_color, gm_id")
    .eq("league_id", LEAGUE_ID)
    .order("division")
    .order("name");

  if (franchiseErr) throw franchiseErr;

  const { data: wallets, error: walletErr } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, balance, starting_wallet")
    .eq("league_id", LEAGUE_ID)
    .eq("season", SEASON);

  if (walletErr) throw walletErr;

  const { data: caps, error: capErr } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select("division, soft_cap, hard_apron")
    .eq("league_id", LEAGUE_ID);

  if (capErr) throw capErr;

  return {
    franchises: (franchises ?? []) as Franchise[],
    wallets: (wallets ?? []) as Wallet[],
    caps: (caps ?? []) as CapConfig[],
  };
}

export default async function CapStatusPage() {
  const { franchises, wallets, caps } = await getData();

  const walletByFranchise = new Map(wallets.map((w) => [w.franchise_id, w]));
  const capByDivision = new Map(caps.map((c) => [c.division, c]));

  const byDivision = DIVISION_ORDER.map((division) => ({
    division,
    label: DIVISION_LABELS[division] ?? division,
    cap: capByDivision.get(division),
    teams: franchises.filter((f) => f.division === division),
  })).filter((group) => group.teams.length > 0);

  return (
    <main className="min-h-screen bg-[#0C0D0F] text-[#EDEDEE]">
      <header className="border-b border-[#232428] px-6 py-8 sm:px-10">
        <p className="text-sm tracking-wide text-[#8A8D93]">Truth Racing League</p>
        <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Franchise Cap Status</h1>
        <p className="mt-2 max-w-xl text-sm text-[#8A8D93]">
          Live wallet balances against each division&rsquo;s Soft Cap and Hard
          Apron, per CRRB Financial Regulations v2.2.
        </p>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-10 sm:px-10">
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

                    {wallet ? (
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
                          {formatMoney(spend)} spent of {cap ? formatMoney(cap.soft_cap) : "—"} soft cap
                        </p>
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-[#8A8D93]">
                        No wallet on record for season {SEASON}.
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
