import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

interface PersonnelCreateBody {
  full_name: string
  team_name?: string | null
  position_category: 'driver' | 'staff'
  position: string
  driver_number?: number | null
  league_id?: string | null
  attributes?: Record<string, number | string>
  notes?: string | null
  discord_id?: string | null // whoever is adding this custom entry
}

export async function GET(req: NextRequest) {
  const supabase = createAdminClient()
  const { searchParams } = new URL(req.url)

  const teamName = searchParams.get('team_name')
  const positionCategory = searchParams.get('position_category')
  const leagueId = searchParams.get('league_id')
  const source = searchParams.get('source')

  let query = supabase
    .schema('pitboss')
    .from('fm_personnel')
    .select(
      'id, league_id, full_name, team_name, position_category, position, driver_number, source, is_active, attributes, notes, created_by, created_at, updated_at'
    )
    .eq('is_active', true)
    .order('team_name', { ascending: true })
    .order('full_name', { ascending: true })

  if (teamName) query = query.eq('team_name', teamName)
  if (positionCategory) query = query.eq('position_category', positionCategory)
  if (source) query = query.eq('source', source)
  // Game-canon rows have no league_id; custom rows are scoped to a league.
  // Requesting a league_id returns that league's custom roster plus every
  // game-canon row, so the UI can show both in one list.
  if (leagueId) query = query.or(`league_id.eq.${leagueId},league_id.is.null`)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ personnel: data ?? [] })
}

export async function POST(req: NextRequest) {
  let body: PersonnelCreateBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    full_name,
    team_name = null,
    position_category,
    position,
    driver_number = null,
    league_id = null,
    attributes = {},
    notes = null,
    discord_id = null,
  } = body

  if (!full_name || !position_category || !position) {
    return NextResponse.json(
      { error: 'full_name, position_category, and position are required' },
      { status: 400 },
    )
  }
  if (position_category !== 'driver' && position_category !== 'staff') {
    return NextResponse.json(
      { error: "position_category must be 'driver' or 'staff'" },
      { status: 400 },
    )
  }

  const supabase = createAdminClient()

  const { data, error } = await supabase
    .schema('pitboss')
    .from('fm_personnel')
    .insert({
      full_name,
      team_name,
      position_category,
      position,
      driver_number,
      league_id,
      attributes,
      notes,
      source: 'custom', // this route only ever creates custom entries —
                         // game-canon rows are seeded via migration, not this API
      created_by: discord_id,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ personnel: data }, { status: 201 })
}
