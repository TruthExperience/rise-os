// src/lib/pitboss/leagueAdminAccess.ts
//
// "Is this driver a league admin?" checks for PitBoss API routes, based on
// the same pitboss.driver_leagues flags that isAuthorizedForCapAdmin reads
// (is_commissioner, is_owner, is_co_owner).
//
// Server-only.

import { createAdminClient } from "@/lib/supabase/server";

type Flags = {
  is_commissioner?: boolean | null;
  is_owner?: boolean | null;
  is_co_owner?: boolean | null;
};

function hasAdminFlag(row: Flags | null | undefined): boolean {
  return Boolean(row?.is_commissioner || row?.is_owner || row?.is_co_owner);
}

/** True when the driver is a commissioner, owner or co-owner of the league. */
export async function isPitbossLeagueAdmin(
  driverId: string,
  leagueId: string
): Promise<boolean> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_commissioner, is_owner, is_co_owner")
    .eq("driver_id", driverId)
    .eq("league_id", leagueId)
    .maybeSingle();

  if (error || !data) return false;
  return hasAdminFlag(data);
}

/**
 * True when the acting driver is a commissioner, owner or co-owner of at
 * least one league that the target driver belongs to.
 */
export async function isAdminOverDriver(
  actingDriverId: string,
  targetDriverId: string
): Promise<boolean> {
  const admin = createAdminClient();

  const { data: targetRows, error: targetErr } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("league_id")
    .eq("driver_id", targetDriverId);

  if (targetErr || !targetRows?.length) return false;

  const leagueIds = targetRows.map((r: any) => r.league_id);

  const { data: actingRows, error: actingErr } = await admin
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_commissioner, is_owner, is_co_owner")
    .eq("driver_id", actingDriverId)
    .in("league_id", leagueIds);

  if (actingErr || !actingRows?.length) return false;
  return actingRows.some((r: any) => hasAdminFlag(r));
}
