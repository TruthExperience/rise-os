// src/app/api/pitboss/incidents/route.ts
// POST — submit an incident report.
// Access rules:
//   TRL  → role must contain 'team_principal' or 'sporting_director'
//   WSC  → any driver in the league
//   AWC  → any driver in the league

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

const TRL_LEAGUE_ID  = '3a005e8d-c35f-4a57-aa27-c59c0c3812e2'
const TRL_PRIVILEGED = ['team_principal', 'sporting_director', 'commissioner', 'head_steward']

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const supabase = getSupabase()

  // Resolve driver record from Discord ID
  const { data: driver } = await supabase
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  if (!driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  let query = supabase
    .from('incidents')
    .select('id, incident_type, description, status, verdict, penalty_points, season, round, lap, created_at, league_id, accused_driver_id')
    .eq('reported_by', driver.id)
    .order('created_at', { ascending: false })

  if (leagueId) {
    query = query.eq('league_id', leagueId)
  }

  const { data: incidents, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ incidents: incidents ?? [] })
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await req.json()
  const {
    league_id,
    incident_type,
    description,
    season,
    round,
    lap,
    evidence_urls,
    accused_driver_id,
    accused_discord_username, // manual fallback
  } = body

  if (!league_id || !incident_type || !description) {
    return NextResponse.json(
      { error: 'league_id, incident_type, and description are required' },
      { status: 400 }
    )
  }

  const supabase = getSupabase()

  // Resolve submitter's driver record
  const { data: reporter } = await supabase
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  if (!reporter) {
    return NextResponse.json({ error: 'Your driver record was not found' }, { status: 403 })
  }

  // Check league membership + role
  const { data: membership } = await supabase
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', reporter.id)
    .eq('league_id', league_id)
    .single()

  if (!membership) {
    return NextResponse.json(
      { error: 'You are not a member of this league' },
      { status: 403 }
    )
  }

  // TRL: only privileged roles can submit
  if (league_id === TRL_LEAGUE_ID) {
    const roles = membership.role.split(',').map((r: string) => r.trim().toLowerCase())
    const hasAccess = roles.some((r: string) => TRL_PRIVILEGED.includes(r))
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Only Team Principals or Sporting Directors can submit incident reports in TRL' },
        { status: 403 }
      )
    }
  }

  // Resolve accused driver — prefer UUID, fall back to Discord username lookup
  let resolvedAccusedId = accused_driver_id ?? null
  if (!resolvedAccusedId && accused_discord_username) {
    const { data: accused } = await supabase
      .from('drivers')
      .select('id')
      .ilike('discord_username', accused_discord_username.trim())
      .single()
    resolvedAccusedId = accused?.id ?? null
  }

  const { data: incident, error } = await supabase
    .from('incidents')
    .insert({
      league_id,
      reported_by: reporter.id,
      accused_driver_id: resolvedAccusedId,
      incident_type,
      description,
      season: season ?? null,
      round: round ? Number(round) : null,
      lap: lap ? Number(lap) : null,
      evidence_urls: evidence_urls?.length ? evidence_urls : null,
      status: 'open',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ incident }, { status: 201 })
}
