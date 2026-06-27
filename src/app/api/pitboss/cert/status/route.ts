import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const CERT_WINDOW_MS = 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(req.url)

  const league_id = searchParams.get('league_id')
  const role_code = searchParams.get('role_code')

  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

  if (role_code) {
    // ── Single role ──────────────────────────────────────────────────────────
    const { data, error } = await supabase.rpc('get_cert_status', {
      p_discord_id: discordId,
      p_league_id:  league_id,
      p_role_code:  role_code,
    })

    if (error) return fallbackSingle(supabase, discordId, league_id, role_code)
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
    }
    return NextResponse.json(buildStatus(data[0]))
  }

  // ── All roles: return array with cert status merged into each ────────────
  const { data: roles, error: rolesError } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('role_code, role_name, question_count, pass_mark, description')
    .eq('league_id', league_id)
    .order('role_code')

  if (rolesError) return NextResponse.json({ error: rolesError.message }, { status: 500 })
  if (!roles || roles.length === 0) return NextResponse.json({ data: [] })

  const results = await Promise.all(
    roles.map(async (role) => {
      const { data, error } = await supabase.rpc('get_cert_status', {
        p_discord_id: discordId,
        p_league_id:  league_id,
        p_role_code:  role.role_code,
      })

      const certStatus = (!error && data && data.length > 0)
        ? buildStatus(data[0])
        : { status: 'eligible', attempt_number: 0 }

      return {
        role_code:      role.role_code,
        role_name:      role.role_name,
        question_count: role.question_count,
        pass_mark:      role.pass_mark,
        description:    role.description,
        ...certStatus,
      }
    })
  )

  return NextResponse.json({ data: results })
}

function buildStatus(row: {
  driver_id:         string
  cert_id:           string | null
  role_code:         string | null
  cert_status:       string | null
  score:             number | null
  pass_mark:         number | null
  started_at:        string | null
  completed_at:      string | null
  locked_until:      string | null
  attempt_number:    number | null
  token:             string | null
  licence_id:        string | null
  licence_number:    string | null
  licence_status:    string | null
  licence_issued_at: string | null
}) {
  const now = new Date()

  if (!row.cert_id) return { status: 'eligible', attempt_number: 0 }

  let effectiveStatus = row.cert_status ?? 'eligible'

  if (
    row.cert_status === 'in_progress' &&
    row.started_at &&
    now.getTime() - new Date(row.started_at).getTime() > CERT_WINDOW_MS
  ) {
    effectiveStatus = 'timed_out'
  }

  if (
    row.cert_status === 'failed' &&
    row.locked_until &&
    new Date(row.locked_until) <= now
  ) {
    effectiveStatus = 'eligible'
  }

  const licence = row.licence_id
    ? {
        id:             row.licence_id,
        licence_number: row.licence_number,
        status:         row.licence_status,
        issued_at:      row.licence_issued_at,
      }
    : null

  return {
    status:           effectiveStatus,
    certification_id: row.cert_id,
    role_code:        row.role_code,
    score:            row.score,
    pass_mark:        row.pass_mark,
    started_at:       row.started_at,
    completed_at:     row.completed_at,
    locked_until:     row.locked_until,
    attempt_number:   row.attempt_number,
    token:            row.cert_status === 'passed' ? row.token : null,
    licence,
  }
}

async function fallbackSingle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  discordId: string,
  league_id: string,
  role_code: string
) {
  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: cert } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, status, score, pass_mark, started_at, completed_at, locked_until, attempt_number, token, role_code')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!cert) return NextResponse.json({ status: 'eligible', attempt_number: 0 })

  const now = new Date()
  let effectiveStatus = cert.status

  if (
    cert.status === 'in_progress' &&
    cert.started_at &&
    now.getTime() - new Date(cert.started_at).getTime() > CERT_WINDOW_MS
  ) effectiveStatus = 'timed_out'

  if (
    cert.status === 'failed' &&
    cert.locked_until &&
    new Date(cert.locked_until) <= now
  ) effectiveStatus = 'eligible'

  let licence = null
  if (cert.status === 'passed') {
    const { data: licenceData } = await supabase
      .schema('pitboss')
      .from('licences')
      .select('id, licence_number, status, issued_at')
      .eq('driver_id', driver.id)
      .eq('league_id', league_id)
      .eq('role_code', role_code)
      .eq('status', 'active')
      .maybeSingle()
    licence = licenceData
  }

  return NextResponse.json({
    status:           effectiveStatus,
    certification_id: cert.id,
    role_code:        cert.role_code,
    score:            cert.score,
    pass_mark:        cert.pass_mark,
    started_at:       cert.started_at,
    completed_at:     cert.completed_at,
    locked_until:     cert.locked_until,
    attempt_number:   cert.attempt_number,
    token:            cert.status === 'passed' ? cert.token : null,
    licence,
  })
}
