import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

// NOTE: previously gated on getServerSession(authOptions) (next-auth),
// which is a different auth system than the rest of the app now uses —
// see the identical fix in /api/pitboss/drivers/me/leagues. Swapped to
// getAuthedDriver() (Supabase Auth) to match. This route only needed the
// session as an auth gate (nothing else referenced session.user), so the
// swap is a straight substitution.

export async function GET(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  if (!leagueId) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { data, error } = await supabase
    .schema('rise_os')
    .from('calendar_rounds')
    .select('*')
    .eq('league_id', leagueId)
    .order('race_date', { ascending: true, nullsFirst: false })
    .order('break_start', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[season/calendar]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ rounds: data ?? [] })
}
