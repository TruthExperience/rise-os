import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  const supabase = createAdminClient()

  // Resolve requesting driver
  const { data: requestingDriver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  // Fetch incident
  const { data: incident, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (error) {
    console.error('[incidents/id] fetch', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  // Auth gate: only reporter, accused, or resolver can view
  const allowed =
    incident.reported_by === requestingDriver.id ||
    incident.accused_driver_id === requestingDriver.id ||
    incident.resolved_by === requestingDriver.id

  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Join reporter
  const { data: reporter } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, discord_username, display_name, discord_avatar')
    .eq('id', incident.reported_by)
    .maybeSingle()

  // Join accused
  const { data: accused } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, discord_username, display_name, discord_avatar')
    .eq('id', incident.accused_driver_id)
    .maybeSingle()

  // Join league
  const { data: league } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', incident.league_id)
    .maybeSingle()

  return NextResponse.json({
    incident: {
      ...incident,
      reporter,
      accused,
      league,
    },
  })
}
