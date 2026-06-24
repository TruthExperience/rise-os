// src/app/api/pitboss/licences/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — list licences with optional filters
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const league_id   = searchParams.get('league_id')
  const driver_id   = searchParams.get('driver_id')
  const status      = searchParams.get('status')
  const role_code   = searchParams.get('role_code')
  const page        = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit       = Math.min(100, Number(searchParams.get('limit') ?? 25))
  const offset      = (page - 1) * limit

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
      driver:drivers(id, discord_id, discord_username, display_name, discord_avatar, pp_total, super_licence_status),
      league:rise_os.leagues(id, name, slug, sport)
      `,
      { count: 'exact' }
    )
    .order('issued_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (league_id) query = query.eq('league_id', league_id)
  if (driver_id) query = query.eq('driver_id', driver_id)
  if (status)    query = query.eq('status', status)
  if (role_code) query = query.eq('role_code', role_code)

  const { data, error, count } = await query

  if (error) {
    console.error('[licences:GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    data,
    meta: { total: count ?? 0, page, limit, pages: Math.ceil((count ?? 0) / limit) },
  })
}

// POST — issue a new licence, auto-generating the licence_number via sequences
export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    driver_id,
    league_id,
    role_code,
    title,
    tier,
    era_endorsements,
    expires_at,
    photo_url,
  } = body

  // Validate required fields
  if (!driver_id || !league_id || !role_code || !title) {
    return NextResponse.json(
      { error: 'driver_id, league_id, role_code, and title are required' },
      { status: 400 }
    )
  }

  // Validate role_code
  const VALID_ROLES = ['driver', 'reserve', 'steward', 'commissioner']
  if (!VALID_ROLES.includes(role_code)) {
    return NextResponse.json(
      { error: `role_code must be one of: ${VALID_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  // Guard: driver must be certified in this league before receiving a licence
  const { data: membership, error: memberError } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('certified, role')
    .eq('driver_id', driver_id)
    .eq('league_id', league_id)
    .single()

  if (memberError || !membership) {
    return NextResponse.json(
      { error: 'Driver is not a member of this league' },
      { status: 403 }
    )
  }

  // Stewards/commissioners don't need certification; drivers/reserves do
  const requiresCert = ['driver', 'reserve'].includes(role_code)
  if (requiresCert && !membership.certified) {
    return NextResponse.json(
      
