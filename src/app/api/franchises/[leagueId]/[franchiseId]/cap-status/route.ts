// app/api/franchises/[leagueId]/[franchiseId]/cap-status/route.ts

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getAuthedDriver } from "@/lib/getSupabaseUserId";
import { calculateCapHit, calculateLuxuryTax, getLeagueCapConfig, LeagueNotConfiguredError } from "@/lib/pitboss/financial-engine";

export async function GET(
  req: NextRequest,
  { params }: { params: { leagueId: string; franchiseId: string } }
) {
  const driver = await getAuthedDriver();
  if (!driver) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { leagueId, franchiseId } = params;
  const division = req.nextUrl.searchParams.get("division");
  const season = req.nextUrl.searchParams.get("season");

  if (!division || !season) {
    return NextResponse.json(
      { error: "division and season query params are required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  try {
    const config = await getLeagueCapConfig(admin, leagueId, division);
    const capHit = await calculateCapHit(admin, { leagueId, division, franchiseId, season });
    const tax = calculateLuxuryTax(capHit.softCapPayroll, config);

    return NextResponse.json({
      leagueId,
      franchiseId,
      division,
      season,
      capHit,
      projectedLuxuryTax: tax,
    });
  } catch (err) {
    if (err instanceof LeagueNotConfiguredError) {
      return NextResponse.json(
        { error: err.message, code: "LEAGUE_NOT_CONFIGURED" },
        { status: 409 }
      );
    }
    console.error("cap-status error:", err);
    return NextResponse.json({ error: "Internal error calculating cap status" }, { status: 500 });
  }
}
