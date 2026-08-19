import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM']
const STEWARD_LEAGUE_ROLES = ['co_owner', 'commissioner', 'head_steward', 'bsac_chief']

/**
 * Resolves the requesting user's pitboss.drivers row.
 *
 * `session` is accepted but ignored — it's a leftover NextAuth-shaped
 * parameter from before the Supabase Auth migration. getServerSession()
 * now always returns null (nothing writes that session cookie anymore),
 * so `session.user` was throwing on every call this reached. Resolution
 * now happens via getAuthedDriver(), which reads the actual Supabase
 * session from cookies and matches pitboss.drivers by discord_id OR
 * user_id (see allow_null_discord_id_on_pitboss_drivers migration).
 *
 * Kept the (supabase, session) signature so existing call sites don't
 * need to change. Safe to drop both params next time this file is
 * touched, once callers are updated to call getRequestingDriver() bare.
 */
export async function getRequestingDriver(
  _supabase?: SupabaseClient,
  _session?: unknown
): Promise<{ id: string } | null> {
  const driver = await getAuthedDriver()
  if (!driver) return null
  return { id: driver.id }
}

export async function hasStewwardAccess(
  supabase: SupabaseClient,
  driverId: string,
  leagueId: string
): Promise<boolean> {
  // NOTE: this used to also check for a steward licence in ANY league
  // (no league_id filter) and grant access if found — meaning a steward
  // in one league got steward access in every other league too. That
  // fallback has been removed; only a licence scoped to leagueId, or a
  // driver_leagues membership scoped to leagueId, can grant access here.
  const { data: licence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLES)
    .maybeSingle()

  if (licence) return true

  const { data: memberships } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role, league_id')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)

  if (!memberships) return false

  for (const m of memberships) {
    const roles = (m.role as string)
      .split(',')
      .map((r: string) => r.trim().toLowerCase())
    if (roles.some((r: string) => STEWARD_LEAGUE_ROLES.includes(r))) {
      return true
    }
  }

  return false
}
