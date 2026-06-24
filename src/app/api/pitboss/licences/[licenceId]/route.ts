import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ licenceId: string }> }

const VALID_STATUSES = ['active', 'suspended', 'revoked', 'expired']

const SELECT = `
  id, licence_number, role_code, title, tier, era_endorsements, status,
  issued_at, expires_at, photo_url, qr_token, created_at, updated_at,
  driver:driver_id ( id, discord_username, display_name, discord_avatar, tier, pp_total, super_licence_status ),
  league:league_id ( id, name, slug )
`

export async function GET(_req: NextRequest, { params }: Params) {
  const { licenceId } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .schema('pitboss')
    .from('licences')
    .select(SELECT)
    .eq('id', licenceId)
    .maybeSingle()

  if (error) {
    console.error('[GET /api/pitboss/licences/[licenceId]]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Licence not found' }, { status: 404 })

  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { licenceId } = await params
  const supabase = await createClient()

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const allowed = ['status', 'title', 'tier', 'expires_at', 'photo_url', 'era_endorsements']
  const update: Record<string, unknown> = {}
  for (const key of allowed) { if (key in body) update[key] = body[key] }

  if (Object.keys(update).length === 0)
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })

  if (update.status !== undefined && !VALID_STATUSES.includes(update.status as string))
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })

  update.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .schema('pitboss')
    .from('licences')
    .update(update)
    .eq('id', licenceId)
    .select(SELECT)
    .maybeSingle()

  if (error) {
    console.error('[PATCH /api/pitboss/licences/[licenceId]]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Licence not found' }, { status: 404 })

  return NextResponse.json({ data })
}
