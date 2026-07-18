import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'
import { getRequestingDriver } from '@/lib/pitboss/stewardAccess'

const STEWARD_ROLE_CODES = ['STW', 'HEAD_STW', 'BSAC_CHIEF']

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

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
