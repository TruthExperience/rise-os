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

  if (incident.status !== 'resolved') {
    return NextResponse.json(
      { error: `Cannot appeal an incident with status "${incident.status}" — only resolved incidents can be appealed` },
      { status: 409 }
    )
  }

  // Block appeals once the round has finalized — appeals are only valid
  // before finalize, per league policy.
  if (incident.round_id) {
    const { data: round } = await supabase
      .schema('rise_os')
      .from('calendar_rounds')
      .select('status')
      .eq('id', incident.round_id)
      .maybeSingle()

    if (round?.status === 'final') {
      return NextResponse.json(
        { error: 'Cannot appeal — the round this incident belongs to has already been finalized' },
        { status: 409 }
      )
    }
  }

  const isSteward  = await hasStewardAccess(supabase, requestingDriver.id, incident.league_id)
  const isAccused  = incident.accused_driver_id === requestingDriver.id
  const isReporter = incident.reported_by === requestingDriver.id

  if (!isSteward && !isAccused && !isReporter) {
    return NextResponse.json(
      { error: 'Only the accused driver, the reporter, or a steward can appeal this incident' },
      { status: 403 }
    )
  }

  const body = await req.json()
  const { reason } = body

  if (!reason?.trim()) {
    return NextResponse.json({ error: 'Appeal reason is required' }, { status: 400 })
  }

  // One appeal per incident, ever — regardless of outcome
  const { data: existingAppeal } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .select('id')
    .eq('incident_id', incident.id)
    .maybeSingle()

  if (existingAppeal) {
    return NextResponse.json(
      { error: 'This incident has already been appealed and cannot be appealed again' },
      { status: 409 }
    )
  }

  const { data: appeal, error: appealError } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .insert({
      incident_id:              incident.id,
      league_id:                incident.league_id,
      appealed_by:              requestingDriver.id,
      reason:                   reason.trim(),
      original_verdict:         incident.verdict,
      original_penalty:         incident.penalty,
      original_penalty_points:  incident.penalty_points,
    })
    .select()
    .single()

  if (appealError) {
    console.error('[incidents/id/appeal POST]', appealError)
    return NextResponse.json({ error: appealError.message }, { status: 500 })
  }

  const { error: statusError } = await supabase
    .schema('pitboss')
    .from('incidents')
    .update({ status: 'appealed' })
    .eq('id', incident.id)

  if (statusError) {
    console.error('[incidents/id/appeal POST] status update', statusError)
    return NextResponse.json({ error: statusError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, appeal })
}
