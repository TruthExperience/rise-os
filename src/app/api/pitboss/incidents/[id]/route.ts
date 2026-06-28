async function hasStewwardAccess(supabase: any, driverId: string, leagueId: string): Promise<boolean> {
  // Check active steward licence first
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

  // Fallback: check driver_leagues boolean flags
  const { data: dl } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('is_co_owner, is_commissioner, is_head_steward, is_bsac_chief')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)
    .maybeSingle()

  if (!dl) return false
  return dl.is_co_owner || dl.is_commissioner || dl.is_head_steward || dl.is_bsac_chief
}
