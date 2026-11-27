/**
 * cap-spend.ts
 *
 * The single "how much has this franchise spent" calculation, shared by the
 * Discord `/cap view` command and the admin cap-status page. Both used to do
 * their own arithmetic — the page subtracted the wallet balance, the command
 * summed contract bases — so they disagreed by the salary total the moment a
 * contract existed. Anything that reports spend must go through here.
 *
 * Spend is:
 *   every active contract's per-season base for the wallet's season
 *   minus net ledger adjustments (bonuses reduce spend, penalties add to it)
 *
 * Ledger rows that are NOT adjustments:
 *   - season_start_grant — it *is* the wallet's opening balance (starting_wallet)
 *   - contract_signing   — the same money is already charged through the
 *                          contract's per-season base
 *   - related_type=config_reset — restates the opening balance when the cap
 *                          model changed; counting it doubled every team's spend
 *
 * The wallet balance is deliberately not the source of truth: base salaries
 * are charged against the cap, not debited from the wallet (only signing
 * bonuses are), so `starting_wallet - balance` is not "spent".
 */

import { contractCoversSeason, contractSeasonBase } from "./financial-engine";

/** Ledger transaction types that are already represented elsewhere. */
export const CAP_NON_SPEND_TRANSACTION_TYPES: string[] = [
  "season_start_grant",
  "contract_signing",
];

export type CapSpendContract = {
  contract_value?: unknown;
  base_salary_per_season?: unknown;
  season_start?: unknown;
  season_end?: unknown;
};

export type CapSpendAdjustment = { amount?: unknown };

export type CapSpendLedgerRow = {
  transaction_type?: string | null;
  related_type?: string | null;
  amount?: unknown;
};

export interface CapSpendResult {
  /** Sum of active contract bases for the season. */
  contractSpend: number;
  /** Net of bonus/penalty ledger adjustments (positive = reduces spend). */
  netAdjustment: number;
  computedSpend: number;
  computedRemaining: number | null;
  /** Stored wallet balance vs cap-minus-spend; true means the wallet is stale. */
  balanceDrift: boolean;
}

/**
 * True when a ledger row counts against spend. Mirrors the query `/cap view`
 * runs, so the page can fetch rows broadly and filter identically.
 */
export function isCapSpendAdjustment(row: CapSpendLedgerRow): boolean {
  if (row.related_type === "config_reset") return false;
  const type = row.transaction_type ?? null;
  if (type && CAP_NON_SPEND_TRANSACTION_TYPES.includes(type)) return false;
  return true;
}

export function computeCapSpend(params: {
  contracts: CapSpendContract[];
  /** Season the wallet is for; null falls back to each contract's own start. */
  walletSeason: string | null;
  adjustments: CapSpendAdjustment[];
  startingWallet: number | null;
  storedBalance: number | null;
}): CapSpendResult {
  const contractSpend = params.contracts.reduce((sum, c) => {
    const season =
      params.walletSeason ?? (c.season_start != null ? String(c.season_start) : "");
    if (!season || !contractCoversSeason(c, season)) return sum;
    return sum + contractSeasonBase(c, season);
  }, 0);

  // Positive amounts (bonuses) reduce spend; negative amounts (penalties)
  // increase it.
  const netAdjustment = params.adjustments.reduce(
    (sum, t) => sum + (Number(t.amount) || 0),
    0
  );

  const computedSpend = contractSpend - netAdjustment;
  const computedRemaining =
    params.startingWallet !== null ? params.startingWallet - computedSpend : null;
  const balanceDrift =
    params.storedBalance !== null &&
    computedRemaining !== null &&
    Math.abs(params.storedBalance - computedRemaining) > 0.01;

  return {
    contractSpend,
    netAdjustment,
    computedSpend,
    computedRemaining,
    balanceDrift,
  };
}
