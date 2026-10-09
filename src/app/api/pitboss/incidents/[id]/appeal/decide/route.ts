import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getRequestingDriver, hasStewwardAccess } from '@/lib/pitboss/stewardAccess'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession()
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

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
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

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { action, new_verdict, new_penalty, new_penalty_points, review_notes = null } = body ?? {}

  if (!['uphold', 'overturn', 'dismiss'].includes(action)) {
    return NextResponse.json({ error: 'action must be "uphold", "overturn", or "dismiss"' }, { status: 400 })
  }
  if (
    new_penalty_points != null &&
    (typeof new_penalty_points !== 'number' || !Number.isFinite(new_penalty_points) || new_penalty_points < 0 || new_penalty_points > 1000)
  ) {
    return NextResponse.json({ error: 'new_penalty_points must be a number between 0 and 1000' }, { status: 400 })
  }
  if (typeof review_notes === 'string' && review_notes.length > 4000) {
    return NextResponse.json({ error: 'review_notes is too long (max 4000 characters)' }, { status: 400 })
  }

  const now = new Date().toISOString()

  // Claim the appeal atomically. Only the request that finds it still open and
  // not yet reviewed gets to decide it, so a double-click or two stewards at
  // once can't both run an overturn (which would remove and re-issue the
  // penalty twice). If a later step fails the claim is released so the appeal
  // can be retried. (No new status value: incident_appeals_status_check only
  // allows open / upheld / overturned / dismissed.)
  const { data: claimed } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .update({ reviewed_by: requestingDriver.id, reviewed_at: now })
    .eq('id', appeal.id)
    .eq('status', 'open')
    .is('reviewed_at', null)
    .select('id')
    .maybeSingle()

  if (!claimed) {
    return NextResponse.json({ error: 'This appeal is already being decided' }, { status: 409 })
  }
  const releaseClaim = async () => {
    await supabase.schema('pitboss').from('incident_appeals')
      .update({ reviewed_by: null, reviewed_at: null })
      .eq('id', appeal.id)
      .eq('status', 'open')
  }

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
      await releaseClaim()
      return NextResponse.json({ error: appealUpdateError.message }, { status: 500 })
    }

    const { error: incidentUpdateError } = await supabase
      .schema('pitboss')
      .from('incidents')
      .update({ status: 'resolved' })
      .eq('id', incident.id)

    if (incidentUpdateError) {
      console.error('[appeal/decide POST] incident status reset', incidentUpdateError)
      await releaseClaim()
      return NextResponse.json({ error: incidentUpdateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, outcome: action })
  }

  // ── action === 'overturn' ────────────────────────────────────────────────
  if (!new_verdict || typeof new_verdict !== 'string') {
    await releaseClaim()
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
    await releaseClaim()
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
      await releaseClaim()
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
    await releaseClaim()
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
