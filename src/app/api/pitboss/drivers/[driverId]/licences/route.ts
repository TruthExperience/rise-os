// src/app/api/pitboss/drivers/[driverId]/licences/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type Params = { params: { driverId: string } }

// GET — all licences held by this driver, across all leagues
export async function GET(req: NextRequest, { params }: Params) {
  const { driverId } = params
  const { searchParams } = req.nextUrl
  const league_id = searchParams.get('league_id')
  const status    = searchParams.get('status')
  const role_code = searchParams.get('role_code')

  // Confirm driver exists
  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select(`
      id,
      discord_id,
      discord_username,
      display_name,
      discord_avatar,
      tier,
      pp_total,
      super_licence_status,
      era_endorsements
    `)
    .eq('id', driverId)
    .single()

  if (driverError || !driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  // Build licences query
  let query = supabase
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
      league:rise_os.leagues (
        id,
        name,
        slug,
        sport,
        logo_url,
        discord_server_id
      )
    `)
    .eq('driver_id', driverId)
    .order('issued_at', { ascending: false })

  if (league_id) query = query.eq('league_id', league_id)
  if (status)    query = query.eq('status', status)
  if (role_code) query = query.eq('role_code', role_code)

  const { data: licences, error: licencesError } = await query

  if (licencesError) {
    console.error('[drivers/[driverId]/licences:GET]', licencesError)
    return NextResponse.json({ error: licencesError.message }, { status: 500 })
  }

  // Per-league active penalty points
  const leagueIds = [...new Set(licences?.map((l: any) => l.league?.id).filter(Boolean))]

  const penaltiesByLeague: Record<string, number> = {}

  if (leagueIds.length) {
    const { data: penalties } = await supabase
      .schema('pitboss')
      .from('penalty_ledger')
      .select('league_id, points, expires_at')
      .eq('driver_id', driverId)
      .in('league_id', leagueIds)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)

    for (const p of penalties ?? []) {
      penaltiesByLeague[p.league_id] = (penaltiesByLeague[p.league_id] ?? 0) + p.points
    }
  }

  // Attach active_pp to each licence
  const enriched = (licences ?? []).map((l: any) => ({
    ...l,
    active_pp: penaltiesByLeague[l.league?.id] ?? 0,
  }))

  // Summary counts across all licences
  const summary = {
    total: enriched.length,
    active:    enriched.filter((l: any) => l.status === 'active').length,
    suspended: enriched.filter((l: any) => l.status === 'suspended').length,
    revoked:   enriched.filter((l: any) => l.status === 'revoked').length,
    expired:   enriched.filter((l: any) => l.status === 'expired').length,
  }

  return NextResponse.json({ driver, licences: enriched, summary })
}

// POST — issue a new licence for this driver
export async function POST(req: NextRequest, { params }: Params) {
  const { driverId } = params
  const body = await req.json()
  const { league_id, role_code, title, tier, era_endorsements, expires_at, photo_url } = body

  if (!league_id || !role_code || !title) {
    return NextResponse.json(
      { error: 'league_id, role_code, and title are required' },
      { status: 400 }
    )
  }

  const VALID_ROLES = ['driver', 'reserve', 'steward', 'commissioner']
  if (!VALID_ROLES.includes(role_code)) {
    return NextResponse.json(
      { error: `role_code must be one of: ${VALID_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  // Confirm driver exists
  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('id', driverId)
    .single()

  if (driverError || !driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  // Block issuance if driver's super licence is suspended or revoked
  if (['suspended', 'revoked'].includes(driver.super_licence_status)) {
    return NextResponse.json(
      {
        error: `Cannot issue a licence — driver's super licence is ${driver.super_licence_status}`,
        super_licence_status: driver.super_licence_status,
      },
      { status: 403 }
    )
  }

  // Confirm league membership
  const { data: membership, error: memberError } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role, certified, certified_at')
    .eq('driver_id', driverId)
    .eq('league_id', league_id)
    .single()

  if (memberError || !membership) {
    return NextResponse.json(
      { error: 'Driver is not a member of this league' },
      { status: 403 }
    )
  }

  // Drivers and reserves must be certified
  if (['driver', 'reserve'].includes(role_code) && !membership.certified) {
    return NextResponse.json(
      { error: 'Driver must pass certification before a licence can be issued' },
      { status: 403 }
    )
  }

  // Block duplicate active/suspended licence for same driver + league + role
  const { data: existing } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id, licence_number, status')
    .eq('driver_id', driverId)
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .in('status', ['active', 'suspended'])
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      {
        error: `Driver already holds an ${existing.status} licence for this role`,
        existing_licence: existing.licence_number,
      },
      { status: 409 }
    )
  }

  // Atomically increment sequence
  const { data: sequenceNumber, error: seqError } = await supabase.rpc(
    'increment_licence_sequence',
    { p_league_id: league_id, p_role_code: role_code }
  )

  if (seqError || sequenceNumber == null) {
    console.error('[drivers/[driverId]/licences:POST] sequence error', seqError)
    return NextResponse.json({ error: 'Failed to generate licence number' }, { status: 500 })
  }

  const prefix = role_code.slice(0, 3).toUpperCase()
  const licence_number = `${prefix}-${String(sequenceNumber).padStart(4, '0')}`

  const { data: licence, error: licenceError } = await supabase
    .schema('pitboss')
    .from('licences')
    .insert({
      driver_id:       driverId,
      league_id,
      licence_number,
      role_code,
      title,
      tier:             tier ?? null,
      era_endorsements: era_endorsements ?? [],
      status:           'active',
      issued_at:        new Date().toISOString(),
      expires_at:       expires_at ?? null,
      photo_url:        photo_url ?? null,
    })
    .select(`
      *,
      league:rise_os.leagues (id, name, slug, sport)
    `)
    .single()

  if (licenceError) {
    console.error('[drivers/[driverId]/licences:POST]', licenceError)
    return NextResponse.json({ error: licenceError.message }, { status: 500 })
  }

  return NextResponse.json({ data: licence }, { status: 201 })
}
