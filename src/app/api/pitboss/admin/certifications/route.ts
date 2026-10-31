// src/app/api/pitboss/admin/certifications/route.ts
// GET /api/pitboss/admin/certifications?league_id=<uuid>
//
// League-admin view of certification attempts (most recent first).
// Gated on commissioner / owner / co-owner for the requested league.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver, createAdminClient } from '@/lib/supabase/server'
import { isPitbossLeagueAdmin } from '@/lib/pitboss/leagueAdminAccess'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  if (!leagueId || !UUID_RE.test(leagueId)) {
    return NextResponse.json({ error: 'A valid league_id is required' }, { status: 400 })
  }

  if (!(await isPitbossLeagueAdmin(driver.id, leagueId))) {
    return NextResponse.json(
      { error: 'Only league owners, co-owners and commissioners can view this' },
      { status: 403 }
    )
  }

  const supabase = createAdminClient()

  const { data: certs, error } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select(
      'id, driver_id, role_code, status, score, pass_mark, started_at, completed_at, locked_until, attempt_number, created_at'
    )
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const driverIds = [...new Set((certs ?? []).map((c) => c.driver_id))]
  let nameById: Record<string, string> = {}

  if (driverIds.length > 0) {
    const { data: drivers, error: driversError } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_username, display_name')
      .in('id', driverIds)

    if (driversError) {
      return NextResponse.json({ error: driversError.message }, { status: 500 })
    }

    nameById = Object.fromEntries(
      (drivers ?? []).map((d) => [d.id, d.display_name || d.discord_username || d.id])
    )
  }

  return NextResponse.json({
    certifications: (certs ?? []).map((c) => ({
      ...c,
      driver_name: nameById[c.driver_id] ?? 'Unknown driver',
    })),
  })
}
