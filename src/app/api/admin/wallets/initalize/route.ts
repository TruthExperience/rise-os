// app/api/admin/wallets/initialize/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/pitboss/getSupabaseUserId";
import { isAuthorizedForCapAdmin } from "@/lib/pitboss/isAuthorizedForCapAdmin";
import { getLeagueCapConfig, LeagueNotConfiguredError } from "@/lib/pitboss/financial-engine";

export async function POST(req: NextRequest) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { leagueId, division, season, franchiseIds } = body ?? {};

  if (!leagueId || !division || !season || !Array.isArray(franchiseIds) || franchiseIds.length === 0) {
    return NextResponse.json(
      { error: "leagueId, division, season, and a non-empty franchiseIds array are required" },
      { status: 400 }
    );
  }

  const authorized = await isAuthorizedForCapAdmin(driver.id, leagueId);
  if (!authorized) {
    return NextResponse.json({ error: "Not authorized for cap administration in this league" }, { status: 403 });
  }

  const admin = createAdminClient();

  try {
    const config = await getLeagueCapConfig(admin, leagueId, division);

    const rows = franchiseIds.map((franchiseId: string) => ({
      franchise_id: franchiseId,
      league_id: leagueId,
      division,
      season,
      balance: config.starting_wallet,
      starting_wallet: config.starting_wallet,
      seasons_over_soft_cap: 0,
      cap_freeze_active: false,
    }));

    // Upsert so re-running initialize for a season already bootstrapped is
    // idempotent rather than erroring on a duplicate (franchise_id, league_id,
    // division, season) row.
    const { data: wallets, error: upsertErr } = await admin
      .schema("pitboss")
      .from("franchise_wallets")
      .upsert(rows, { onConflict: "franchise_id,league_id,division,season" })
      .select("id, franchise_id, balance");

    if (upsertErr) {
      throw new Error(`Failed to upsert franchise_wallets: ${upsertErr.message}`);
    }

    // Log a season_start_grant transaction per wallet for the ledger trail.
    const txRows = (wallets ?? []).map((w) => ({
      wallet_id: w.id,
      franchise_id: w.franchise_id,
      league_id: leagueId,
      season,
      transaction_type: "season_start_grant",
      amount: config.starting_wallet,
      balance_after: w.balance,
      description: `Season start wallet grant per league_financial_config (${config.source_document ?? "no source document set"})`,
      created_by: driver.id,
    }));

    if (txRows.length > 0) {
      const { error: txErr } = await admin
        .schema("pitboss")
        .from("wallet_transactions")
        .insert(txRows);
      if (txErr) {
        // Wallets were created; log this loudly but don't fail the whole
        // request over the audit trail insert — the balances are correct.
        console.error("wallets/initialize: wallet_transactions insert failed", txErr);
      }
    }

    return NextResponse.json({ initialized: wallets?.length ?? 0, wallets });
  } catch (err) {
    if (err instanceof LeagueNotConfiguredError) {
      return NextResponse.json(
        { error: err.message, code: "LEAGUE_NOT_CONFIGURED" },
        { status: 409 }
      );
    }
    console.error("wallets/initialize error:", err);
    return NextResponse.json({ error: "Internal error initializing wallets" }, { status: 500 });
  }
}
