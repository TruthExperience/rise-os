import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// Same editor gate roster_assign/roster_remove and sign-driver/release-driver
// use. Duplicated here rather than imported because driver.ts doesn't export
// it — worth centralizing later if a fourth command needs it.
const EDITOR_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
  "is_head_steward",
  "is_steward",
] as const;

// Mirrors normalizeSeason() in driver.ts. Not imported for the same reason
// EDITOR_FLAGS isn't — no shared module yet. Keep in sync if that function
// changes: sign-driver writes driver_contracts.season_start using this same
// extraction, so a mismatch here means /contract view season filters silently
// stop matching (the same class of bug as the 2026-09-03 stuck-roster issue).
function normalizeSeason(raw: string): { season: string } | { error: string } {
  const trimmed = raw.trim();
  const match = trimmed.match(/\d+/);
  if (!match) {
    return { error: `Season must contain a number (e.g. "3"). Got: "${raw}".` };
  }
  return { season: match[0] };
}

type DriverContractRow = {
  id: string;
  contract_class: string | null;
  season_start: string | null;
  season_end: string | null;
  base_salary_per_season: Record<string, number | string> | null;
  signing_bonus: string | number | null;
  performance_bonuses: unknown;
  special_conditions: string | null;
  status: string;
  division: string | null;
  tier: string | null;
  contract_value: string | number | null;
  ddv_at_signing: string | number | null;
  contract_floor: string | number | null;
  contract_ceiling: string | number | null;
  buyout_clause: string | number | null;
  dead_cap_pct: string | number | null;
  is_rookie_contract: boolean;
  hybrid_buffer_applied: boolean;
  grace_period_sessions_remaining: number;
  cooling_off_until: string | null;
  released_at: string | null;
  released_reason: string | null;
  franchise_id: string;
  created_at: string;
};

async function getFranchiseName(franchiseId: string): Promise<string> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("name")
    .eq("id", franchiseId)
    .maybeSingle();
  return data?.name ?? "Unknown franchise";
}

function fmtMoney(v: string | number | null): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString();
}

function fmtSalaryBySeason(v: Record<string, number | string> | null): string | null {
  if (!v || Object.keys(v).length === 0) return null;
  return Object.entries(v)
    .map(([season, amount]) => `S${season}: ${fmtMoney(amount as any)}`)
    .join(", ");
}

function formatContract(row: DriverContractRow, franchiseName: string): string {
  const lines: string[] = [];

  const seasonRange = row.season_end && row.season_end !== row.season_start
    ? `${row.season_start}–${row.season_end}`
    : row.season_start ?? "unknown";

  lines.push(`**${franchiseName}** — ${row.contract_class ?? "no class"}${row.tier ? ` (${row.tier})` : ""}`);
  lines.push(`Season: ${seasonRange} | Division: ${row.division ?? "—"} | Status: **${row.status}**`);

  const value = fmtMoney(row.contract_value);
  if (value) lines.push(`Contract value: ${value}`);

  const salaryBySeason = fmtSalaryBySeason(row.base_salary_per_season);
  if (salaryBySeason) lines.push(`Base salary: ${salaryBySeason}`);

  const signingBonus = fmtMoney(row.signing_bonus);
  if (signingBonus) lines.push(`Signing bonus: ${signingBonus}`);

  if (row.performance_bonuses && (Array.isArray(row.performance_bonuses) ? row.performance_bonuses.length > 0 : Object.keys(row.performance_bonuses as object).length > 0)) {
    lines.push(`Performance bonuses: ${JSON.stringify(row.performance_bonuses)}`);
  }

  const floor = fmtMoney(row.contract_floor);
  const ceiling = fmtMoney(row.contract_ceiling);
  if (floor || ceiling) lines.push(`Cap range: ${floor ?? "—"} to ${ceiling ?? "—"}`);

  const ddv = fmtMoney(row.ddv_at_signing);
  if (ddv) lines.push(`DDV at signing: ${ddv}`);

  const buyout = fmtMoney(row.buyout_clause);
  if (buyout) lines.push(`Buyout clause: ${buyout}`);

  if (row.dead_cap_pct !== null && row.dead_cap_pct !== undefined) {
    const pct = typeof row.dead_cap_pct === "string" ? Number(row.dead_cap_pct) : row.dead_cap_pct;
    lines.push(`Dead cap: ${(pct * 100).toFixed(0)}%`);
  }

  const flags: string[] = [];
  if (row.is_rookie_contract) flags.push("rookie contract");
  if (row.hybrid_buffer_applied) flags.push("hybrid buffer applied");
  if (row.grace_period_sessions_remaining > 0) flags.push(`${row.grace_period_sessions_remaining} grace sessions remaining`);
  if (flags.length > 0) lines.push(`Flags: ${flags.join(", ")}`);

  if (row.cooling_off_until) lines.push(`Cooling-off until: ${row.cooling_off_until}`);

  if (row.special_conditions) lines.push(`Special conditions: ${row.special_conditions}`);

  if (row.status !== "active" && row.released_at) {
    lines.push(`Released ${row.released_at}${row.released_reason ? ` (${row.released_reason})` : ""}`);
  }

  return lines.join("\n");
}

registerCommand("contract_view", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const requestedDiscordId = (ctx.options.driver as string | undefined) ?? ctx.discordUserId;
  const rawSeason = ctx.options.season as string | undefined;

  const viewingSelf = requestedDiscordId === ctx.discordUserId;
  if (!viewingSelf) {
    const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
    if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
      return { content: "You can only view your own contract.", ephemeral: true };
    }
  }

  let seasonFilter: string | null = null;
  if (rawSeason) {
    const seasonResult = normalizeSeason(rawSeason);
    if ("error" in seasonResult) {
      return { content: seasonResult.error, ephemeral: true };
    }
    seasonFilter = seasonResult.season;
  }

  const supabase = createAdminClient();

  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", requestedDiscordId)
    .maybeSingle();

  if (!driver) {
    return {
      content: viewingSelf
        ? "You don't have a driver profile in this league yet."
        : `<@${requestedDiscordId}> doesn't have a driver profile in this league yet.`,
      ephemeral: true,
    };
  }

  let query = supabase
    .schema("pitboss")
    .from("driver_contracts")
    .select(
      "id, contract_class, season_start, season_end, base_salary_per_season, signing_bonus, performance_bonuses, special_conditions, status, division, tier, contract_value, ddv_at_signing, contract_floor, contract_ceiling, buyout_clause, dead_cap_pct, is_rookie_contract, hybrid_buffer_applied, grace_period_sessions_remaining, cooling_off_until, released_at, released_reason, franchise_id, created_at"
    )
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId);

  if (seasonFilter) {
    query = query.eq("season_start", seasonFilter);
  }

  const { data: contracts, error } = await query.order("created_at", { ascending: false });

  if (error) {
    console.error("[contract_view] driver_contracts lookup failed:", error);
    return { content: `Something went wrong looking up the contract: ${error.message}`, ephemeral: true };
  }

  if (!contracts || contracts.length === 0) {
    return {
      content: seasonFilter
        ? `No contract found for ${viewingSelf ? "you" : `<@${requestedDiscordId}>`} in season ${seasonFilter}.`
        : `${viewingSelf ? "You don't" : `<@${requestedDiscordId}> doesn't`} have any contract on file in this league.`,
      ephemeral: true,
    };
  }

  // No season given: prefer the active contract. If there's more than one
  // active row (shouldn't happen, but driver_contracts has no partial
  // unique index like franchise_rosters does), surface all of them rather
  // than silently picking one.
  let toShow: DriverContractRow[];
  if (seasonFilter) {
    toShow = contracts as DriverContractRow[];
  } else {
    const active = (contracts as DriverContractRow[]).filter((c) => c.status === "active");
    toShow = active.length > 0 ? active : [(contracts as DriverContractRow[])[0]];
  }

  const sections = await Promise.all(
    toShow.map(async (row) => {
      const franchiseName = await getFranchiseName(row.franchise_id);
      return formatContract(row, franchiseName);
    })
  );

  const header = viewingSelf ? "Your contract" : `<@${requestedDiscordId}>'s contract`;
  const multiple = toShow.length > 1;

  return {
    content: `**${header}${multiple ? "s" : ""}**\n\n${sections.join("\n\n")}`,
    ephemeral: viewingSelf ? true : false,
  };
});
