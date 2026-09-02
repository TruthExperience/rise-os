// app/api/admin/luxury-tax/assess/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/pitboss/getSupabaseUserId";
import { isAuthorizedForCapAdmin } from "@/lib/pitboss/isAuthorizedForCapAdmin";
import {
  calculateCapHit,
  calculateLuxuryTax,
  getLeagueCapConfig,
  LeagueNotConfiguredError,
} from "@/lib/pitboss/financial-engine";

export async function POST(req: NextRequest) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { leagueId, division, season, franchiseId, rosterLockDate } = body ?? {};

  if (!leagueId || !division || !season || !franchiseId || !rosterLockDate) {
    return NextResponse.json(
      { error: "leagueId, division, season, franchiseId, and rosterLockDate are all required" },
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
    const capHit = await calculateCapHit(admin, { leagueId, division, franchiseId, season });
    const tax = calculateLuxuryTax(capHit.softCapPayroll, config);

    // Per CRRB Fin Regs v2.2 Art 1.3: "Franchises have 48 hours to file a
    // formal CRRB dispute before the tax is deducted." Assessment is created
    // as 'pending', not auto-deducted — deduction is a separate action after
    // the dispute window closes.
    const disputeDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const { data: assessment, error: insertErr } = await admin
      .schema("pitboss")
      .from("luxury_tax_assessments")
      .insert({
        franchise_id: franchiseId,
        league_id: leagueId,
        division,
        season,
        total_payroll: capHit.softCapPayroll,
        soft_cap: config.soft_cap,
        overage: tax.overage,
        tax_owed: tax.totalTaxOwed,
        band_breakdown: tax.bandBreakdown,
        roster_lock_date: rosterLockDate,
        dispute_deadline: disputeDeadline,
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) {
      throw new Error(`Failed to insert luxury_tax_assessments: ${insertErr.message}`);
    }

    return NextResponse.json({ assessment, capHit });
  } catch (err) {
    if (err instanceof LeagueNotConfiguredError) {
      return NextResponse.json(
        { error: err.message, code: "LEAGUE_NOT_CONFIGURED" },
        { status: 409 }
      );
    }
    console.error("luxury-tax/assess error:", err);
    return NextResponse.json({ error: "Internal error assessing luxury tax" }, { status: 500 });
  }
}
