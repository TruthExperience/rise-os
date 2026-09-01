import { NextRequest, NextResponse } from "next/server";
import { getDriverCoachingTrends } from "@/lib/pitboss/coaching-history";
import { getAuthedDriver } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Season-long coaching trends for one driver — the "dynamic"/ongoing
 * counterpart to the single-lap report served by /api/pitboss/telemetry/
 * coach. Defaults to the requester's own trends; a steward can request
 * another driver's by passing driver_id, gated on sharing at least one
 * league in common where the requester holds a steward role (same shape
 * of check as the per-session route, generalized since trends span many
 * sessions/leagues rather than one).
 */
export async function GET(req: NextRequest) {
  const requester = await getAuthedDriver();
  if (!requester) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const driverIdParam = req.nextUrl.searchParams.get("driver_id");
  const targetDriverId = driverIdParam ?? requester.id;

  const trackId = req.nextUrl.searchParams.get("track_id");

  const limitParam = req.nextUrl.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam != null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit <= 0) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
  }

  if (targetDriverId !== requester.id) {
    const admin = createAdminClient();
    const { data: targetLeagues } = await admin
      .schema("pitboss")
      .from("driver_leagues")
      .select("league_id")
      .eq("driver_id", targetDriverId);

    const leagueIds = (targetLeagues ?? []).map((r) => r.league_id);
    let isSteward = false;
    if (leagueIds.length > 0) {
      const { data: membership } = await admin
        .schema("pitboss")
        .from("driver_leagues")
        .select("is_steward, is_head_steward")
        .eq("driver_id", requester.id)
        .in("league_id", leagueIds)
        .or("is_steward.eq.true,is_head_steward.eq.true");
      isSteward = !!membership && membership.length > 0;
    }

    if (!isSteward) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  try {
    const trends = await getDriverCoachingTrends(targetDriverId, trackId, limit);
    return NextResponse.json(trends);
  } catch (err) {
    console.error("[pitboss/telemetry/coach/trends] failed", err);
    return NextResponse.json({ error: "failed to compute coaching trends" }, { status: 500 });
  }
}
