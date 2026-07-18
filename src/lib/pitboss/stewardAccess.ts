import type { SupabaseClient } from '@supabase/supabase-js'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM']
const STEWARD_LEAGUE_ROLES = ['co_owner', 'commissioner', 'head_steward', 'bsac_chief']

export async function getRequestingDriver(supabase: SupabaseClient, session: any) {
  const user = session.user as any
  const discordId: string | undefined = user.discordId ?? user.discord_id ?? user.id
  const email: string | undefined = user.email ?? undefined

  let driver = null

  if (discordId) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id')
      .eq('discord_id', discordId)
      .maybeSingle()
    driver = data
  }

  if (!driver && email) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    driver = data
  }

  return driver
}

export async function hasStewwardAccess(
  supabase: SupabaseClient,
  driverId: string,
  leagueId: string
): Promise<boolean> {
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

  const { data: anyLicence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', driverId)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLES)
    .maybeSingle()

  if (anyLicence) return true

  const { data: memberships } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role, league_id')
    .eq('driver_id', driverId)

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
