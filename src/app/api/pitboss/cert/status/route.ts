import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

const CERT_WINDOW_MS = 60 * 60 * 1000

function effectiveStatus(cert: any, now: Date): string {
  if (
    cert.status === 'in_progress' &&
    cert.started_at &&
    now.getTime() - new Date(cert.started_at).getTime() > CERT_WINDOW_MS
  ) {
    return 'timed_out'
  }
  if (cert.status === 'failed' && cert.locked_until && new Date(cert.locked_until) <= now) {
    return 'eligible'
  }
  return cert.status
}

export async function GET(req: NextRequest) {
  const supabase = createAdminClient()
  const { searchParams } = new URL(req.url)

  const league_id = searchParams.get('league_id')
  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss').from('drivers')
    .select('id').eq('discord_id', discordId).maybeSingle()

  if (driverError) {
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: certs, error: certsError } = await supabase
    .schema('pitboss').from('certifications')
    .select('id, role_code, status, score, pass_mark, started_at, completed_at, locked_until, attempt_number, token')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .order('created_at', { ascending: false })

  if (certsError) {
    return NextResponse.json({ error: certsError.message }, { status: 500 })
  }

  const { data: licences, error: licencesError } = await supabase
    .schema('pitboss').from('licences')
    .select('id, role_code, licence_number, status, issued_at')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .eq('status', 'active')

  if (licencesError) {
    return NextResponse.json({ error: licencesError.message }, { status: 500 })
  }

  const licenceByRole = new Map((licences ?? []).map((l) => [l.role_code, l]))

  const latestByRole = new Map<string, any>()
  for (const c of certs ?? []) {
    if (!latestByRole.has(c.role_code)) latestByRole.set(c.role_code, c)
  }

  const now = new Date()
  const statuses = Array.from(latestByRole.values()).map((cert) => ({
    role_code:         cert.role_code,
    status:            effectiveStatus(cert, now),
    certification_id:  cert.id,
    score:             cert.score,
    pass_mark:         cert.pass_mark,
    started_at:        cert.started_at,
    completed_at:      cert.completed_at,
    locked_until:      cert.locked_until,
    attempt_number:    cert.attempt_number,
    token:             cert.status === 'passed' ? cert.token : null,
    licence:           cert.status === 'passed' ? (licenceByRole.get(cert.role_code) ?? null) : null,
  }))

  return NextResponse.json({ statuses })
}
