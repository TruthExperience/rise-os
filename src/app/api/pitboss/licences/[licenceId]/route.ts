// src/app/api/pitboss/licences/[licenceId]/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type Params = { params: { licenceId: string } }

// Valid status transitions
const TRANSITIONS: Record<string, string[]> = {
  active:    ['suspended', 'revoked', 'expired'],
  suspended: ['active', 'revoked'],
  revoked:   [],
  expired:   [],
}

// GET — fetch single licence with full driver + league detail
export async function GET(_req: NextRequest, { params }: Params) {
  const { licenceId } = params

  const { data, error } = await supabase
    .schema('pitboss')
    .from('licences')
    .select(`
      id,
      licence_number,
      role_code,
      title,
      tier,
      era_endorsements,
      status,
      issued_at,
      expires_at,
      photo_url,
      qr_token,
      driver:drivers (
        id,
        discord_id,
        discord_username,
        display_name,
        discord_avatar,
        tier,
        pp_total,
        super_licence_status,
        era_endorsements,
        driver_leagues (
          role,
          certified,
          certified_at,
          joined_at
        ),
        driver_gamertags (
          platform,
          gamertag,
          is_primary
        )
      ),
      league:rise_os.leagues (
        id,
        name,
        slug,
        sport,
        discord_server_id
      )
    `)
    .eq('id', licenceId)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 })
  }

  // Enrich with current penalty point total from ledger
  const { data: penalties } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select('points, reason, issued_at, expires_at')
    .eq('driver_id', (data.driver as any).id)
    .eq('league_id', (data as any).league?.id)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)

  const active_pp = penalties?.reduce((sum, p) => sum + p.points, 0) ?? 0

  return NextResponse.json({ data: { ...data, active_pp, penalties: penalties ?? [] } })
}

// PATCH — update licence fields and/or status
export async function PATCH(req: NextRequest, { params }: Params) {
  const { licenceId } = params
  const body = await req.json()
  const {
    status,
    title,
    tier,
    era_endorsements,
    expires_at,
    photo_url,
  } = body

  // Fetch current licence
  const { data: current, error: fetchError } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id, status, driver_id, league_id, role_code')
    .eq('id', licenceId)
    .single()

  if (fetchError || !current) {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 })
  }

  // Validate status transition if provided
  if (status && status !== current.status) {
    const allowed = TRANSITIONS[current.status] ?? []
    if (!allowed.includes(status)) {
      return NextResponse.json(
        {
          error: `Cannot transition licence from '${current.status}' to '${status}'`,
          allowed_transitions: allowed,
        },
        { status: 422 }
      )
    }
  }

  // Build update payload — only include fields present in body
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (status          !== undefined) updates.status          = status
  if (title           !== undefined) updates.title           = title
  if (tier            !== undefined) updates.tier            = tier
  if (era_endorsements !== undefined) updates.era_endorsements = era_endorsements
  if (expires_at      !== undefined) updates.expires_at      = expires_at
  if (photo_url       !== undefined) updates.photo_url       = photo_url

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { data: updated, error: updateError } = await supabase
    .schema('pitboss')
    .from('licences')
    .update(updates)
    .eq('id', licenceId)
    .select()
    .single()

  if (updateError) {
    console.error('[licences/[licenceId]:PATCH]', updateError)
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // Mirror critical status changes onto the driver's super_licence_status
  if (status && ['suspended', 'revoked', 'active'].includes(status)) {
    const superStatus =
      status === 'suspended' ? 'review' :
      status === 'revoked'   ? 'suspended' :
      'active'

    await supabase
      .schema('pitboss')
      .from('drivers')
      .update({ super_licence_status: superStatus })
      .eq('id', current.driver_id)
  }

  return NextResponse.json({ data: updated })
}

// DELETE — hard revoke (no physical delete; licences are permanent records)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { licenceId } = params

  const { data: current, error: fetchError } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id, status, driver_id, league_id')
    .eq('id', licenceId)
    .single()

  if (fetchError || !current) {
    return NextResponse.json({ error: 'Licence not found' }, { status: 404 })
  }

  if (current.status === 'revoked') {
    return NextResponse.json({ error: 'Licence is already revoked' }, { status: 409 })
  }

  if (!TRANSITIONS[current.status]?.includes('revoked')) {
    return NextResponse.json(
      { error: `Cannot revoke a licence with status '${current.status}'` },
      { status: 422 }
    )
  }

  const { data: revoked, error: revokeError } = await supabase
    .schema('pitboss')
    .from('licences')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('id', licenceId)
    .select()
    .single()

  if (revokeError) {
    console.error('[licences/[licenceId]:DELETE]', revokeError)
    return NextResponse.json({ error: revokeError.message }, { status: 500 })
  }

  // Escalate driver's super licence status to suspended
  await supabase
    .schema('pitboss')
    .from('drivers')
    .update({ super_licence_status: 'suspended' })
    .eq('id', current.driver_id)

  return NextResponse.json({ data: revoked })
}
