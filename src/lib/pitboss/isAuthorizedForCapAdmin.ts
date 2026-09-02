import { createAdminClient } from "@/lib/supabase/server";

/**
 * Interim CRRB/cap-admin permission gate.
 *
 * There is no dedicated CRRB role flag on pitboss.driver_leagues today —
 * only is_commissioner / is_owner / is_co_owner / is_team_principal / etc.
 * Franchise ownership and CRRB membership are not the same authority in
 * TRL's own rulebook (CRRB is a non-affiliated body per CRRB Charter v3.2
 * Art 1; a TP is explicitly NOT non-affiliated), so this is a known,
 * intentional gap — owners are being granted cap-admin access as a stopgap,
 * not because the rulebook says they should have it.
 *
 * Kept as a single named function so that when a real is_crrb_member (or
 * equivalent) column exists, every route calling this gets the fix in one
 * place instead of a grep-and-replace across every financial route.
 */
export async function isAuthorizedForCapAdmin(
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

  return Boolean(data.is_commissioner || data.is_owner || data.is_co_owner);
}
