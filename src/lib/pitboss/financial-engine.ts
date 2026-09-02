/**
 * financial-engine.ts
 *
 * League-agnostic financial engine for PitBoss.
 *
 * DESIGN PRINCIPLE: This file contains ZERO hardcoded league numbers.
 * Every cap figure, tax band, DDV weight, and rule flag is read from
 * pitboss.league_financial_config at call time. TRL's $120M/$175M and
 * 4-band tax table are DATA, not code — a different league can have a
 * completely different cap structure without touching this file.
 *
 * If a league has no config row for the requested division, every
 * function here throws LeagueNotConfiguredError rather than silently
 * falling back to another league's numbers. Fail loud, not wrong.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class LeagueNotConfiguredError extends Error {
  constructor(public leagueId: string, public division: string) {
    super(
      `No league_financial_config row for league_id=${leagueId}, division="${division}". ` +
      `This league/division has not been financially configured yet. ` +
      `An admin must insert a config row before cap or tax operations can run.`
    );
    this.name = 'LeagueNotConfiguredError';
  }
}

export interface LuxuryTaxBand {
  min_overage: number;
  max_overage: number | null; // null = no upper bound (top band)
  multiplier: number;
}

export interface LeagueFinancialConfig {
  id: string;
  league_id: string;
  division: string;
  starting_wallet: number;
  soft_cap: number;
  hard_apron: number;
  setup_trade_cap: number;
  transfer_fee_cap: number;
  repeater_rule_seasons: number;
  contract_floor_pct: number;
  contract_ceiling_pct: number;
  performance_bonus_cap_pct: number;
  rookie_contract_min: number;
  rookie_contract_max: number;
  conversion_floor: number;
  hardship_floor: number;
  ddv_floor: number;
  ddv_ceiling: number;
  ddv_starting: number;
  ddv_pillar_weights: Record<string, number>;
  ddv_base_rate_per_bps: number;
  ddv_weekend_gain_cap: number;
  ddv_weekend_loss_cap: number;
  luxury_tax_bands: LuxuryTaxBand[];
  off_season_decay_by_tier: Record<string, number>;
  dead_cap_counts_soft: boolean;
  dead_cap_counts_apron: boolean;
  source_document: string | null;
  effective_date: string;
}

export interface CapHitBreakdown {
  activeContractsTotal: number;
  deadCapTotal: number;
  deadCapCountedTowardSoft: number;
  deadCapCountedTowardApron: number;
  softCapPayroll: number;   // active contracts + (dead cap if flagged)
  apronPayroll: number;     // active contracts + (dead cap if flagged)
  softCap: number;
  hardApron: number;
  overSoftCapBy: number;    // 0 if under
  softCapExceeded: boolean;
  apronRoomRemaining: number; // hardApron - apronPayroll; negative = already over
}

export interface LuxuryTaxResult {
  overage: number;
  bandBreakdown: Array<{
    band: LuxuryTaxBand;
    amountInBand: number;
    taxOwedForBand: number;
  }>;
  totalTaxOwed: number;
}

export interface CapCheckResult {
  allowed: boolean;
  reason?: string;
  projectedApronPayroll: number;
  hardApron: number;
  projectedOverage: number; // if allowed=false, how much over
}

// ---------------------------------------------------------------------------
// Config lookup — single source of truth for every other function/route
// ---------------------------------------------------------------------------

/**
 * Fetches the financial config for a given league + division.
 * Throws LeagueNotConfiguredError if no row exists — callers must handle
 * this and surface a clear "not configured" response. Never falls back
 * to defaults or another league's figures.
 */
export async function getLeagueCapConfig(
  supabase: SupabaseClient,
  leagueId: string,
  division: string
): Promise<LeagueFinancialConfig> {
  const { data, error } = await supabase
    .schema('pitboss')
    .from('league_financial_config')
    .select('*')
    .eq('league_id', leagueId)
    .eq('division', division)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch league_financial_config: ${error.message}`);
  }

  if (!data) {
    throw new LeagueNotConfiguredError(leagueId, division);
  }

  return data as LeagueFinancialConfig;
}

// ---------------------------------------------------------------------------
// Cap-hit calculation
// ---------------------------------------------------------------------------

/**
 * Calculates a franchise's current payroll against Soft Cap and Hard Apron,
 * for a given league/division/season. Dead cap inclusion is governed by the
 * config's dead_cap_counts_soft / dead_cap_counts_apron flags — not hardcoded.
 */
export async function calculateCapHit(
  supabase: SupabaseClient,
  params: {
    leagueId: string;
    division: string;
    franchiseId: string;
    season: string; // matches driver_contracts.season_start (text field, not a season_id FK)
  }
): Promise<CapHitBreakdown> {
  const config = await getLeagueCapConfig(supabase, params.leagueId, params.division);

  // Active contracts: sum of contract_value for status='active' rows.
  // NOTE: contract_value is the full contract figure, not a separate
  // per-season cap_hit column — there is no cap_hit column in the schema.
  // If multi-season contracts ever need per-season cap smoothing, this
  // will need to change; today it treats contract_value as the flat
  // annual cap number, matching how DDV Regs Art 4.01 describes floor/
  // ceiling (a single contract value, not season-by-season figures).
  const { data: activeContracts, error: activeErr } = await supabase
    .schema('pitboss')
    .from('driver_contracts')
    .select('contract_value')
    .eq('league_id', params.leagueId)
    .eq('franchise_id', params.franchiseId)
    .eq('division', params.division)
    .eq('season_start', params.season)
    .eq('status', 'active');

  if (activeErr) {
    throw new Error(`Failed to fetch active contracts: ${activeErr.message}`);
  }

  const activeContractsTotal = (activeContracts ?? []).reduce(
    (sum, c) => sum + Number(c.contract_value ?? 0),
    0
  );

  // Dead cap: for 'released' and 'bought_out' contracts, dead cap dollar
  // amount = contract_value * dead_cap_pct (the rate CRRB Fin Regs and
  // Contract Conversion Regs express as a percentage, e.g. 0.50 or 0.25).
  //
  // Deliberately excludes:
  //  - 'voided'    — BSAC guilty findings use the tiered fine bands in
  //                  Articles of Expulsion Art 1.04.4, not dead_cap_pct.
  //                  That fine is calculated elsewhere, not here.
  //  - 'expired'   — natural contract end, zero dead cap by definition.
  //  - 'converted' — P&R tier movement, zero dead cap at origin per
  //                  Contract Conversion Regs Art 2.01 (same-franchise)
  //                  or governed by its own Art 2.02 terms (cross-franchise).
  const { data: deadCapRows, error: deadErr } = await supabase
    .schema('pitboss')
    .from('driver_contracts')
    .select('contract_value, dead_cap_pct')
    .eq('league_id', params.leagueId)
    .eq('franchise_id', params.franchiseId)
    .eq('division', params.division)
    .eq('season_start', params.season)
    .in('status', ['released', 'bought_out'])
    .not('dead_cap_pct', 'is', null);

  if (deadErr) {
    throw new Error(`Failed to fetch dead cap contracts: ${deadErr.message}`);
  }

  const deadCapTotal = (deadCapRows ?? []).reduce(
    (sum, c) => sum + Number(c.contract_value ?? 0) * Number(c.dead_cap_pct ?? 0),
    0
  );

  const deadCapCountedTowardSoft = config.dead_cap_counts_soft ? deadCapTotal : 0;
  const deadCapCountedTowardApron = config.dead_cap_counts_apron ? deadCapTotal : 0;

  const softCapPayroll = activeContractsTotal + deadCapCountedTowardSoft;
  const apronPayroll = activeContractsTotal + deadCapCountedTowardApron;

  const overSoftCapBy = Math.max(0, softCapPayroll - config.soft_cap);

  return {
    activeContractsTotal,
    deadCapTotal,
    deadCapCountedTowardSoft,
    deadCapCountedTowardApron,
    softCapPayroll,
    apronPayroll,
    softCap: config.soft_cap,
    hardApron: config.hard_apron,
    overSoftCapBy,
    softCapExceeded: softCapPayroll > config.soft_cap,
    apronRoomRemaining: config.hard_apron - apronPayroll,
  };
}

// ---------------------------------------------------------------------------
// Luxury tax
// ---------------------------------------------------------------------------

/**
 * Calculates Progressive Luxury Tax owed on the overage above Soft Cap,
 * walking the league's configured tax bands (not a hardcoded 4-tier table).
 * A league can configure any number of bands, any multipliers, or a single
 * flat band — this function just walks whatever's in luxury_tax_bands.
 */
export function calculateLuxuryTax(
  softCapPayroll: number,
  config: LeagueFinancialConfig
): LuxuryTaxResult {
  const overage = Math.max(0, softCapPayroll - config.soft_cap);

  if (overage === 0) {
    return { overage: 0, bandBreakdown: [], totalTaxOwed: 0 };
  }

  const sortedBands = [...config.luxury_tax_bands].sort(
    (a, b) => a.min_overage - b.min_overage
  );

  const bandBreakdown: LuxuryTaxResult['bandBreakdown'] = [];
  let totalTaxOwed = 0;

  for (const band of sortedBands) {
    const bandFloor = band.min_overage;
    const bandCeiling = band.max_overage ?? Infinity;

    if (overage <= bandFloor) continue; // overage hasn't reached this band

    const amountInBand = Math.min(overage, bandCeiling) - bandFloor;
    if (amountInBand <= 0) continue;

    const taxOwedForBand = amountInBand * band.multiplier;
    bandBreakdown.push({ band, amountInBand, taxOwedForBand });
    totalTaxOwed += taxOwedForBand;
  }

  return { overage, bandBreakdown, totalTaxOwed };
}

// ---------------------------------------------------------------------------
// Hard Apron enforcement — the "blocked at the source" check
// ---------------------------------------------------------------------------

/**
 * Validates a hypothetical new contract/transaction against the Hard Apron
 * BEFORE it's committed. This is the function the cap-check route calls to
 * implement "PitBoss blocks any non-compliant transaction at the source"
 * (CRRB Financial Regs v2.2, Art 1.2.2 — this behavior is explicit in the
 * rulebook, unlike the dead-cap inference).
 */
export async function checkHardApronCompliance(
  supabase: SupabaseClient,
  params: {
    leagueId: string;
    division: string;
    franchiseId: string;
    season: string; // matches driver_contracts.season_start
    proposedNewCapHit: number; // the contract_value of the contract being considered
  }
): Promise<CapCheckResult> {
  const config = await getLeagueCapConfig(supabase, params.leagueId, params.division);
  const current = await calculateCapHit(supabase, params);

  const projectedApronPayroll = current.apronPayroll + params.proposedNewCapHit;
  const projectedOverage = Math.max(0, projectedApronPayroll - config.hard_apron);

  if (projectedOverage > 0) {
    return {
      allowed: false,
      reason:
        `Transaction would push Apron payroll to $${projectedApronPayroll.toLocaleString()}, ` +
        `exceeding Hard Apron of $${config.hard_apron.toLocaleString()} by ` +
        `$${projectedOverage.toLocaleString()}. Blocked per Charter Art 6.02 / CRRB Financial Regs Art 1.2.2.`,
      projectedApronPayroll,
      hardApron: config.hard_apron,
      projectedOverage,
    };
  }

  return {
    allowed: true,
    projectedApronPayroll,
    hardApron: config.hard_apron,
    projectedOverage: 0,
  };
}

// ---------------------------------------------------------------------------
// Contract floor/ceiling validation (DDV-driven, per config pcts)
// ---------------------------------------------------------------------------

/**
 * Validates a proposed contract value against the driver's DDV-derived
 * floor/ceiling, using this league's configured percentages (not TRL's
 * hardcoded 20%/110% — those are just what TRL's config currently holds).
 */
export function validateContractAgainstDDV(
  proposedValue: number,
  driverDDV: number,
  config: LeagueFinancialConfig
): { valid: boolean; floor: number; ceiling: number; reason?: string } {
  const floor = driverDDV * config.contract_floor_pct;
  const ceiling = driverDDV * config.contract_ceiling_pct;

  if (proposedValue < floor) {
    return {
      valid: false,
      floor,
      ceiling,
      reason: `Proposed value $${proposedValue.toLocaleString()} is below the ` +
        `DDV-derived floor of $${floor.toLocaleString()} (${config.contract_floor_pct * 100}% of DDV).`,
    };
  }

  if (proposedValue > ceiling) {
    return {
      valid: false,
      floor,
      ceiling,
      reason: `Proposed value $${proposedValue.toLocaleString()} exceeds the ` +
        `DDV-derived ceiling of $${ceiling.toLocaleString()} (${config.contract_ceiling_pct * 100}% of DDV).`,
    };
  }

  return { valid: true, floor, ceiling };
}
