// src/app/pitboss/admin/cap-status/page.tsx
//
// Franchise Cap Status — sits alongside your other flat admin tools
// (rulebooks, appeals, cert, drivers, incidents, licences, penalties,
// results, setups, standings, steward) under /pitboss/admin.
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

// Fallback only — used when no ?league= param is present, so existing
// bookmarks/links to this page keep showing TRL exactly as before.
// Was previously the only league this page could ever show.
const DEFAULT_LEAGUE_ID = "3a005e8d-c35f-4a57-aa27-c59c0c3812e2"; // TRL
const SEASON = "1";

// Used only if a league row somehow has a null/empty currency_code
// (shouldn't happen post-migration, since the column is NOT NULL with
// a default, but kept as a defensive fallback).
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
  // Nullable: some leagues (e.g. W11) have franchises with no division set on
  // rise_os.franchises. Previously a null here crashed the page with
  // "Cannot read properties of null (reading 'match')". The wallet row's
  // division is used as the fallback (see divisionOf below).
  division: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  gm_id: string | null;
};

type Wallet = {
  franchise_id: string;
  division: string | null;
  balance: number;
  starting_wallet: number;
};

type CapConfig = {
  division: string;
  soft_cap: number;
  hard_apron: number;
};

// Known overrides for divisions whose short code doesn't self-describe a
// season (TRL's current F1 division is coded "F1" with no year suffix).
// Anything not in this map — e.g. HRL's "F1_26" — is auto-labelled below
// instead of being silently dropped, which is what happened before.
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

// Sorts divisions with the current/undated season first, then descending
// by year for anything with a "_25" / "_26" style suffix. Works for TRL's
// scheme ("F1", "F1_25") and HRL's scheme ("F1_26", "F1_25") without
// needing a hardcoded order per league.
function divisionSortKey(division: string) {
  const match = division.match(/_(\d{2})$/);
  return match ? -Number(match[1]) : -9999;
}

// Currency prefix now comes from the selected league's own
// currency_code (rise_os.leagues.currency_code) instead of being
// hardcoded to TRL, so every league shows its own wallet currency.
function formatMoney(n: number, currencyCode: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
    .format(n)
    .replace("$", `$${currencyCode} `);
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

  const { data: wallets, error: walletErr } = await supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, division, balance, starting_wallet")
    .eq("league_id", leagueId)
    .eq("season", SEASON);

  if (walletErr) throw walletErr;

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

// Team Principal lookup, keyed by franchise id.
//
// The GM badge previously read only rise_os.franchises.gm_id — never
// populated for HRL, so every card showed "No GM" regardless of who was
// actually running the team.
//
// The real TP source is pitboss.team_rosters.is_team_principal (confirmed
// against src/app/pitboss/discord/commands/ddv.ts, which explicitly warns
// off two other candidates: rise_os.franchises.gm_id, and
// pitboss.driver_leagues.is_team_principal — that's a broader per-league
// role flag, not the team-specific one; a driver can hold it without
// being any specific team's TP this season).
//
// team_rosters itself has no franchise_id — it points at
// pitboss.car_class_teams, a bare-name table ("Red Bull Racing", no year
// suffix, no link to rise_os.franchises) used by the setup recommendation
// engine. So franchise attribution still comes from that driver's active
// pitboss.driver_contracts row for this league/season, same source
// contract_class (D1/D2) uses.
//
// One-time data fix applied 2026-09-05: HRL's team_rosters rows were
// mislabeled season = 'S2' (23 of 24 rows) instead of '1', which is the
// league's actual current season — that mismatch was silently hiding
// every TP from any season-filtered lookup. Confirm new leagues/seasons
// keep team_rosters.season in sync with driver_contracts/franchise_wallets'
// '1'/'2'/'3' scheme going forward.
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

  // Active contract this season is what ties a TP to a specific franchise
  // — same source contract_class (D1/D2) reads from. A driver could in
  // theory hold more than one active contract row; this takes whichever
  // one the query returns first for that driver, matching how the rest of
  // this page already treats "active" as a single-row assumption.
  const { data: contracts, error: contractErr } = await supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select("driver_id, franchise_id")
    .eq("league_id", leagueId)
    .eq("status", "active")
    .in("driver_id", driverIds);

  if (contractErr) thro
