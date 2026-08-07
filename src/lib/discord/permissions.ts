import { createAdminClient } from "@/lib/supabase/server"; // reuse existing server-side admin client pattern

/**
 * Permission flags as they exist on pitboss.driver_leagues.
 * These are per-driver, per-league — a driver can be a TP in one
 * league and a plain driver in another.
 */
export type LeaguePermissionFlag =
  | "is_owner"
  | "is_co_owner"
  | "is_commissioner"
  | "is_head_steward"
  | "is_bsac_chief"
  | "is_team_principal"
  | "is_steward"
  | "is_driver";

export interface LeagueMembership {
  driverId: string;
  leagueId: string;
  role: string | null;
  certified: boolean;
  flags: Record<LeaguePermissionFlag, boolean>;
}

/**
 * Looks up a Discord user's PitBoss driver record and their
 * membership/permissions row for a specific league. Returns null if
 * the user has no driver record, or no membership in that league —
 * callers should treat null as "not authorized" and respond
 * ephemerally rather than throwing.
 */
export async function getLeagueMembership(
  discordId: string,
  leagueId: string
): Promise<LeagueMembership | null> {
  const supabase = createAdminClient();

  const { data: driver, error: driverError } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (driverError || !driver) return null;

  const { data: membership, error: membershipError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select(
      "driver_id, league_id, role, certified, is_owner, is_co_owner, is_commissioner, is_head_steward, is_bsac_chief, is_team_principal, is_steward, is_driver"
    )
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .maybeSingle();

  if (membershipError || !membership) return null;

  return {
    driverId: membership.driver_id,
    leagueId: membership.league_id,
    role: membership.role,
    certified: membership.certified,
    flags: {
      is_owner: membership.is_owner,
      is_co_owner: membership.is_co_owner,
      is_commissioner: membership.is_commissioner,
      is_head_steward: membership.is_head_steward,
      is_bsac_chief: membership.is_bsac_chief,
      is_team_principal: membership.is_team_principal,
      is_steward: membership.is_steward,
      is_driver: membership.is_driver,
    },
  };
}

/**
 * Convenience check: does this membership satisfy ANY of the given
 * flags? Use for commands with multiple valid roles, e.g. roster
 * edits allowed for is_team_principal OR is_commissioner OR is_owner.
 */
export function hasAnyFlag(
  membership: LeagueMembership | null,
  flags: LeaguePermissionFlag[]
): boolean {
  if (!membership) return false;
  return flags.some((flag) => membership.flags[flag]);
}

const ADMINISTRATOR = 1n << 3n;

/**
 * Discord-role-based steward check: does the invoking member either
 * hold the league's configured steward role, or have ADMINISTRATOR
 * (which Discord's interaction payload always includes for the guild
 * owner, regardless of their roles)? Unlike getLeagueMembership/
 * hasAnyFlag, this needs no pitboss.driver_leagues row to exist --
 * it reads straight off the interaction, so a brand-new league needs
 * no manual per-driver flag grants before its owner can use steward
 * commands.
 */
export function hasDiscordStewardAccess(
  ctx: { memberRoles: string[]; memberPermissions: string },
  stewardRoleId: string | null
): boolean {
  const permissions = BigInt(ctx.memberPermissions || "0");
  const isOwnerOrAdmin = (permissions & ADMINISTRATOR) !== 0n;
  const isSteward = stewardRoleId ? ctx.memberRoles.includes(stewardRoleId) : false;
  return isOwnerOrAdmin || isSteward;
}
  
