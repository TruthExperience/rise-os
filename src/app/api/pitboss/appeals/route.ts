import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedDriver } from '@/lib/supabase/supabase-auth'

const STEWARD_ROLE_CODES = ['STW', 'HEAD_STW', 'BSAC_CHIEF']

// NOTE: previously gated on getServerSession(authOptions) (next-auth) and
// resolved the driver via getRequestingDriver(supabase, session) — a
// helper that takes the next-auth session shape. Same broken-auth pattern
// as /api/pitboss/drivers/me/leagues and /api/season/calendar: next-auth's
// session is no longer being populated the way this app's auth now works,
// so both the outer session check AND getRequestingDriver's internal
// lookup would fail on every request. Swapped to getAuthedDriver()
// (Supabase Auth), which returns the resolved driver row directly.
//
// ASSUMPTION: this assumes getRequestingDriver's only job was resolving
// "which driver is this session" (the same thing getAuthedDriver does).
// If stewardAccess.ts's getRequestingDriver does anything beyond that
// (e.g. merging some legacy account, special-casing impersonation, admin
// override), that behavior is lost here and stewardAccess.ts needs a look
// too — flagging this rather than guessing further.

export async function GET(req: NextRequest) {
  const requestingDriver = await getAuthedDriver()
  if (!requestingDriver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { searchParams } = new URL(req.url)
  const statusFilter = searchParams.get('status') // 'open' | 'upheld' | 'overturned' | 'dismissed' | null
  const leagueFilter = searchParams.get('league_id')

  // Leagues where this driver holds an active steward-tier licence —
  // determines which appeals they can see beyond their own.
  const { data: licences, error: licenceError } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('league_id')
    .eq('driver_id', requestingDriver.id)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLE_CODES)

  if (licenceError) {
    console.error('[appeals GET] licence lookup', licenceError)
    return NextResponse.json({ error: licenceError.message }, { status: 500 })
  }

  const stewardLeagueIds = [...new Set((licences ?? []).map((l) => l.league_id))]

  let query = supabase
    .schema('pitboss')
    .from('incident_appeals')
    .select(`
      *,
      incident:incident_id (
        id, incident_type, description, season, round, lap,
        accused_driver_id, reported_by
      ),
      league:league_id ( id, name, slug ),
      appellant:appealed_by ( id, discord_username, display_name, discord_avatar ),
      reviewer:reviewed_by ( id, discord_username, display_name )
    `)
    .order('created_at', { ascending: false })

  // Visibility: appeals in leagues where the driver stewards, OR appeals
  // the driver personally filed — never anyone else's in a non-steward league.
  if (stewardLeagueIds.length > 0) {
    query = query.or(
      `league_id.in.(${stewardLeagueIds.join(',')}),appealed_by.eq.${requestingDriver.id}`
    )
  } else {
    query = query.eq('appealed_by', requestingDriver.id)
  }

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  }
  if (leagueFilter) {
    query = query.eq('league_id', leagueFilter)
  }

  const { data, error } = await query

  if (error) {
    console.error('[appeals GET] fetch', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    appeals: data ?? [],
    isStewardAnywhere: stewardLeagueIds.length > 0,
  })
}
