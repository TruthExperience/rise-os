import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM']
const STEWARD_LEAGUE_ROLES = ['co_owner', 'commissioner', 'head_steward', 'bsac_chief']

async function getRequestingDriver(supabase: any, session: any) {
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

async function hasStewardAccess(
  supabase: any,
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

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident, error: incError } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (incError || !incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  if (incident.status !== 'appealed') {
    return NextResponse.json(
      { error: `Incident is not under appeal (status: "${incident.status}")` },
      { status: 409 }
    )
  }

  const { data: appeal, error: appealError } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .select('*')
    .eq('incident_id', incident.id)
    .eq('status', 'open')
    .maybeSingle()

  if (appealError || !appeal) {
    return NextResponse.json({ error: 'No open appeal found for this incident' }, { status: 404 })
  }

  const isSteward = await hasStewardAccess(supabase, requestingDriver.id, incident.league_id)
  if (!isSteward) {
    return NextResponse.json({ error: 'Forbidden — steward access required' }, { status: 403 })
  }

  // Reviewing steward must be neither the original resolver nor the appellant.
  // TESTING WINDOW: self-review is allowed until SELF_REVIEW_TEST_WINDOW_END
  // below, then this reverts to strict enforcement automatically — no env
  // var to remember to unset. This is a real conflict-of-interest guard in
  // production; only extend the date if you deliberately need more time,
  // don't remove the check itself.
  const SELF_REVIEW_TEST_WINDOW_END = new Date('2026-08-18T00:00:00Z')
  const bypassSelfReview = new Date() < SELF_REVIEW_TEST_WINDOW_END
  if (bypassSelfReview) {
    console.warn(
      `[appeal/decide POST] self-review test window active (expires ${SELF_REVIEW_TEST_WINDOW_END.toISOString()}) — driver ${requestingDriver.id} reviewing incident ${incident.id}`
    )
  }

  if (!bypassSelfReview && requestingDriver.id === incident.resolved_by) {
    return NextResponse.json(
      { error: 'A steward cannot review an appeal of their own ruling' },
      { status: 403 }
    )
  }
  if (!bypassSelfReview && requestingDriver.id === appeal.appealed_by) {
    return NextResponse.json(
      { error: 'A steward cannot review an appeal they filed themselves' },
      { status: 403 }
    )
  }

  const body = await req.json()
  const { action, new_verdict, new_penalty, new_penalty_points, review_notes = null } = body

  if (!['uphold', 'overturn', 'dismiss'].includes(action)) {
    return NextResponse.json({ error: 'action must be "uphold", "overturn", or "dismiss"' }, { status: 400 })
  }

  const now = new Date().toISOString()

  if (action === 'uphold' || action === 'dismiss') {
    // Original verdict/penalty stand unchanged. Just close out the appeal
    // and return the incident to resolved.
    const { error: appealUpdateError } = await supabase
      .schema('pitboss')
      .from('incident_appeals')
      .update({
        status:       action === 'uphold' ? 'upheld' : 'dismissed',
        reviewed_by:  requestingDriver.id,
        reviewed_at:  now,
        review_notes,
      })
      .eq('id', appeal.id)

    if (appealUpdateError) {
      console.error('[appeal/decide POST] uphold/dismiss', appealUpdateError)
      return NextResponse.json({ error: appealUpdateError.message }, { status: 500 })
    }

    const { error: incidentUpdateError } = await supabase
      .schema('pitboss')
      .from('incidents')
      .update({ status: 'resolved' })
      .eq('id', incident.id)

    if (incidentUpdateError) {
      console.error('[appeal/decide POST] incident status reset', incidentUpdateError)
      return NextResponse.json({ error: incidentUpdateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, outcome: action })
  }

  // ── action === 'overturn' ────────────────────────────────────────────────
  if (!new_verdict) {
    return NextResponse.json({ error: 'new_verdict is required to overturn' }, { status: 400 })
  }

  const finalPenaltyPoints = new_penalty_points ?? 0

  // Soft-delete the original penalty_ledger entry tied to this incident, if any.
  // pp_total recalculates automatically via trg_penalty_ledger_pp_total.
  const { error: removeOldLedgerError } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .update({ removed_at: now, removed_by: requestingDriver.id })
    .eq('incident_id', incident.id)
    .is('removed_at', null)

  if (removeOldLedgerError) {
    console.error('[appeal/decide POST] remove old ledger row', removeOldLedgerError)
    return NextResponse.json({ error: removeOldLedgerError.message }, { status: 500 })
  }

  // If the new verdict still carries a penalty, write a fresh ledger row.
  if (new_verdict === 'guilty' && finalPenaltyPoints > 0 && incident.accused_driver_id) {
    const { error: newLedgerError } = await supabase
      .schema('pitboss')
      .from('penalty_ledger')
      .insert({
        driver_id:   incident.accused_driver_id,
        league_id:   incident.league_id,
        incident_id: incident.id,
        points:      finalPenaltyPoints,
        reason:      new_penalty ?? `Incident (appeal overturn): ${incident.incident_type}`,
        issued_at:   now,
        issued_by:   requestingDriver.id,
        source:      'incident',
      })

    if (newLedgerError) {
      console.error('[appeal/decide POST] new ledger row', newLedgerError)
      return NextResponse.json({ error: newLedgerError.message }, { status: 500 })
    }
  }

  const { error: incidentUpdateError } = await supabase
    .schema('pitboss')
    .from('incidents')
    .update({
      status:         'resolved',
      verdict:        new_verdict,
      penalty:        new_penalty ?? null,
      penalty_points: finalPenaltyPoints,
    })
    .eq('id', incident.id)

  if (incidentUpdateError) {
    console.error('[appeal/decide POST] incident overturn update', incidentUpdateError)
    return NextResponse.json({ error: incidentUpdateError.message }, { status: 500 })
  }

  const { error: appealUpdateError } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .update({
      status:             'overturned',
      reviewed_by:        requestingDriver.id,
      reviewed_at:        now,
      review_notes,
      new_verdict,
      new_penalty:        new_penalty ?? null,
      new_penalty_points: finalPenaltyPoints,
    })
    .eq('id', appeal.id)

  if (appealUpdateError) {
    console.error('[appeal/decide POST] appeal overturn record', appealUpdateError)
    return NextResponse.json({ error: appealUpdateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, outcome: 'overturn' })
}
