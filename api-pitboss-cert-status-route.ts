import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ─── GET /api/pitboss/cert/status ─────────────────────────────────────────────
// Query params: league_id (required)
// Returns the driver's latest certification state for the given league.
// Used by the gate page to determine what UI to show.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(req.url)

  const league_id = searchParams.get('league_id')
  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[GET /api/pitboss/cert/status] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  // ── Fetch latest cert for this driver + league ────────────────────────────────
  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select(
      'id, status, score, pass_mark, started_at, completed_at, locked_until, attempt_number, token'
    )
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (certError) {
    console.error('[GET /api/pitboss/cert/status] cert lookup', certError)
    return NextResponse.json({ error: certError.message }, { status: 500 })
  }

  // ── No cert yet → eligible to start ──────────────────────────────────────────
  if (!cert) {
    return NextResponse.json({ status: 'eligible', attempt_number: 0 })
  }

  const now = new Date()

  // ── Resolve effective status ──────────────────────────────────────────────────
  // in_progress with no submission + window expired → treat as timed_out
  const CERT_WINDOW_MS = 60 * 60 * 1000
  let effectiveStatus = cert.status

  if (
    cert.status === 'in_progress' &&
    cert.started_at &&
    now.getTime() - new Date(cert.started_at).getTime() > CERT_WINDOW_MS
  ) {
    effectiveStatus = 'timed_out'
  }

  // ── Locked but lockout has now expired → eligible again ──────────────────────
  if (
    cert.status === 'failed' &&
    cert.locked_until &&
    new Date(cert.locked_until) <= now
  ) {
    effectiveStatus = 'eligible'
  }

  // ── Fetch licence if passed ───────────────────────────────────────────────────
  let licence = null
  if (cert.status === 'passed') {
    const { data: licenceData } = await supabase
      .schema('pitboss')
      .from('licences')
      .select('id, licence_number, status, issued_at')
      .eq('driver_id', driver.id)
      .eq('league_id', league_id)
      .eq('role_code', 'driver')
      .eq('status', 'active')
      .maybeSingle()

    licence = licenceData
  }

  return NextResponse.json({
    status:         effectiveStatus,
    certification_id: cert.id,
    score:          cert.score,
    pass_mark:      cert.pass_mark,
    started_at:     cert.started_at,
    completed_at:   cert.completed_at,
    locked_until:   cert.locked_until,
    attempt_number: cert.attempt_number,
    token:          cert.status === 'passed' ? cert.token : null,
    licence,
  })
}
