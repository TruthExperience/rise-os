import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ─── GET /api/pitboss/licences ────────────────────────────────────────────────
// Query params: league_id, driver_id, role_code, status, page, limit
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(req.url)

  const league_id  = searchParams.get('league_id')
  const driver_id  = searchParams.get('driver_id')
  const role_code  = searchParams.get('role_code')
  const status     = searchParams.get('status')
  const page       = Math.max(1, parseInt(searchParams.get('page')  ?? '1',  10))
  const limit      = Math.min(100, parseInt(searchParams.get('limit') ?? '20', 10))
  const offset     = (page - 1) * limit

  let query = supabase
    .schema('pitboss')
    .from('licences')
    .select(
      `
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
        driver:driver_id (
          id,
          discord_username,
          display_name,
          discord_avatar,
          tier,
          pp_total,
          super_licence_status
        ),
        league:league_id (
          id,
          name,
          slug
        )
      `,
      { count: 'exact' }
    )
    .order('issued_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (league_id) query = query.eq('league_id', league_id)
  if (driver_id) query = query.eq('driver_id', driver_id)
  if (role_code)  query = query.eq('role_code', role_code)
  if (status)     query = query.eq('status', status)

  const { data, error, count } = await query

  if (error) {
    console.error('[GET /api/pitboss/licences]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    data,
    meta: {
      total: count ?? 0,
      page,
      limit,
      pages: Math.ceil((count ?? 0) / limit),
    },
  })
}

// ─── POST /api/pitboss/licences ───────────────────────────────────────────────
// Body: { driver_id, league_id, role_code, title, tier?, photo_url?, expires_at? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  let body: {
    driver_id:   string
    league_id:   string
    role_code:   string
    title:       string
    tier?:       string
    photo_url?:  string
    expires_at?: string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { driver_id, league_id, role_code, title, tier, photo_url, expires_at } = body

  if (!driver_id || !league_id || !role_code || !title) {
    return NextResponse.json(
      { error: 'driver_id, league_id, role_code, and title are required' },
      { status: 400 }
    )
  }

  const validRoles = ['driver', 'reserve', 'steward', 'commissioner']
  if (!validRoles.includes(role_code)) {
    return NextResponse.json(
      { error: `role_code must be one of: ${validRoles.join(', ')}` },
      { status: 400 }
    )
  }

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('id', driver_id)
    .maybeSingle()

  if (driverError) {
    console.error('[POST /api/pitboss/licences] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  if (['suspended', 'revoked'].includes(driver.super_licence_status)) {
    return NextResponse.json(
      { error: `Cannot issue licence — driver super licence is ${driver.super_licence_status}` },
      { status: 403 }
    )
  }

  const { data: membership, error: membershipError } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('id, role, certified')
    .eq('driver_id', driver_id)
    .eq('league_id', league_id)
    .maybeSingle()

  if (membershipError) {
    console.error('[POST /api/pitboss/licences] membership lookup', membershipError)
    return NextResponse.json({ error: membershipError.message }, { status: 500 })
  }
  if (!membership) {
    return NextResponse.json(
      { error: 'Driver is not a member of this league' },
      { status: 403 }
    )
  }

  const requiresCert = ['driver', 'reserve'].includes(role_code)
  if (requiresCert && !membership.certified) {
    return NextResponse.json(
      { error: 'Driver must be certified before a licence can be issued for this role' },
      { status: 403 }
    )
  }

  const { data: existing, error: existingError } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id, licence_number, status')
    .eq('driver_id', driver_id)
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .eq('status', 'active')
    .maybeSingle()

  if (existingError) {
    console.error('[POST /api/pitboss/licences] existing licence check', existingError)
    return NextResponse.json({ error: existingError.message }, { status: 500 })
  }
  if (existing) {
    return NextResponse.json(
      {
        error: `An active ${role_code} licence already exists for this driver in this league`,
        existing_licence: existing.licence_number,
      },
      { status: 409 }
    )
  }

  const rolePrefix: Record<string, string> = {
    driver:       'DRV',
    reserve:      'RSV',
    steward:      'STW',
    commissioner: 'CMR',
  }

  const { data: seqRow, error: seqError } = await supabase
    .schema('pitboss')
    .from('licence_sequences')
    .select('id, last_number')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  if (seqError) {
    console.error('[POST /api/pitboss/licences] sequence lookup', seqError)
    return NextResponse.json({ error: seqError.message }, { status: 500 })
  }

  let nextNumber: number
  if (!seqRow) {
    nextNumber = 1
    const { error: insertSeqErr } = await supabase
      .schema('pitboss')
      .from('licence_sequences')
      .insert({ league_id, role_code, last_number: 1 })

    if (insertSeqErr) {
      console.error('[POST /api/pitboss/licences] sequence insert', insertSeqErr)
      return NextResponse.json({ error: insertSeqErr.message }, { status: 500 })
    }
  } else {
    nextNumber = seqRow.last_number + 1
    const { error: updateSeqErr } = await supabase
      .schema('pitboss')
      .from('licence_sequences')
      .update({ last_number: nextNumber })
      .eq('id', seqRow.id)

    if (updateSeqErr) {
      console.error('[POST /api/pitboss/licences] sequence update', updateSeqErr)
      return NextResponse.json({ error: updateSeqErr.message }, { status: 500 })
    }
  }

  const prefix = rolePrefix[role_code] ?? role_code.toUpperCase().slice(0, 3)
  const licence_number = `${prefix}-${String(nextNumber).padStart(5, '0')}`

  const { data: licence, error: insertError } = await supabase
    .schema('pitboss')
    .from('licences')
    .insert({
      driver_id,
      league_id,
      licence_number,
      role_code,
      title,
      ...(tier        && { tier }),
      ...(photo_url   && { photo_url }),
      ...(expires_at  && { expires_at }),
      status: 'active',
    })
    .select()
    .single()

  if (insertError) {
    console.error('[POST /api/pitboss/licences] insert', insertError)
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ data: licence }, { status: 201 })
}
