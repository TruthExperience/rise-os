// app/api/franchises/[leagueId]/[franchiseId]/cap-check/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/getSupabaseUserId";
import {
  checkHardApronCompliance,
  validateContractAgainstDDV,
  getLeagueCapConfig,
  LeagueNotConfiguredError,
} from "@/lib/pitboss/financial-engine";

export async function POST(
  req: NextRequest,
  { params }: { params: { leagueId: string; franchiseId: string } }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { leagueId, franchiseId } = params;
  const body = await req.json();
  const { division, season, proposedValue, driverDDV } = body ?? {};

  if (!division || !season || typeof proposedValue !== "number" || typeof driverDDV !== "number") {
    return NextResponse.json(
      { error: "division, season, proposedValue, and driverDDV are all required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  try {
    const config = await getLeagueCapConfig(admin, leagueId, division);

    // Gate 1: DDV floor/ceiling (DDV Regs v1.1 Art 4.01) — PitBoss "rejects
    // out-of-range contracts automatically."
    const ddvCheck = validateContractAgainstDDV(proposedValue, driverDDV, config);
    if (!ddvCheck.valid) {
      return NextResponse.json(
        { allowed: false, gate: "ddv_floor_ceiling", ...ddvCheck },
        { status: 200 } // not an error — a well-formed "no" answer
      );
    }

    // Gate 2: Hard Apron (Charter v11.0 Art 6.02 / CRRB Fin Regs Art 1.2.2)
    // — "No transaction may cause a team to exceed this limit."
    const apronCheck = await checkHardApronCompliance(admin, {
      leagueId,
      division,
      franchiseId,
      season,
      proposedNewCapHit: proposedValue,
    });

    if (!apronCheck.allowed) {
      return NextResponse.json(
        { allowed: false, gate: "hard_apron", ddvCheck, ...apronCheck },
        { status: 200 }
      );
    }

    return NextResponse.json({ allowed: true, gate: null, ddvCheck, ...apronCheck });
  } catch (err) {
    if (err instanceof LeagueNotConfiguredError) {
      return NextResponse.json(
        { error: err.message, code: "LEAGUE_NOT_CONFIGURED" },
        { status: 409 }
      );
    }
    console.error("cap-check error:", err);
    return NextResponse.json({ error: "Internal error running cap check" }, { status: 500 });
  }
}
