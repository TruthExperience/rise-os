import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'
import { getRequestingDriver, hasStewwardAccess } from '@/lib/pitboss/stewardAccess'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)
  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('league_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  if (!isSteward) {
    return NextResponse.json({ error: 'Steward access required' }, { status: 403 })
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('incident_steward_comments')
    .select('id, driver_id, body, created_at, drivers(display_name, discord_username)')
    .eq('incident_id', params.id)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ comments: data ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)
  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('league_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  if (!isSteward) {
    return NextResponse.json({ error: 'Steward access required' }, { status: 403 })
  }

  const body = await req.json()
  const text = body?.body

  if (!text?.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('incident_steward_comments')
    .insert({
      incident_id: params.id,
      driver_id:   requestingDriver.id,
      body:        text.trim(),
    })
    .select('id, driver_id, body, created_at, drivers(display_name, discord_username)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ comment: data }, { status: 201 })
}
