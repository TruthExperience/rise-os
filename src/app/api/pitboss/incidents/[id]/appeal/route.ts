import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getRequestingDriver, hasStewwardAccess } from '@/lib/pitboss/stewardAccess'
import { openDiscordAppealTicket } from '@/lib/discord/app-sync'

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

  const isSteward  = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isAccused  = incident.accused_driver_id === requestingDriver.id
  const isReporter = incident.reported_by === requestingDriver.id

  if (!isSteward && !isAccused && !isReporter) {
    return NextResponse.json(
      { error: 'Only the accused driver, the reporter, or a steward can appeal this incident' },
      { status: 403 }
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const reason = typeof body?.reason === 'string' ? body.reason : ''

  if (!reason.trim()) {
    return NextResponse.json({ error: 'Appeal reason is required' }, { status: 400 })
  }
  if (reason.length > 4000) {
    return NextResponse.json({ error: 'Appeal reason is too long (max 4000 characters)' }, { status: 400 })
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
    // 23505 = unique violation: a parallel request filed the appeal first.
    if ((appealError as any).code === '23505') {
      return NextResponse.json(
        { error: 'This incident has already been appealed and cannot be appealed again' },
        { status: 409 }
      )
    }
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

  // Mirror the appeal into Discord (appeal-XXXX channel + pointer in the
  // appeals channel). Never throws; a Discord failure doesn't undo the appeal.
  const discord = await openDiscordAppealTicket(appeal.id)
  if (!discord.ok) {
    console.error('[incidents/id/appeal POST] discord sync', discord.error)
  }
  const channelId = discord.ok ? discord.channelId : null

  return NextResponse.json({
    success: true,
    appeal: { ...appeal, ticket_channel_id: channelId ?? appeal.ticket_channel_id },
    discord_ticket_channel_id: channelId,
  })
}
