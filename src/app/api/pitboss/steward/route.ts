// src/app/api/pitboss/steward/route.ts
// GET — returns incidents for a league, filtered by status.
// Only accessible to users with a steward-level role in that league
// (checked via pitboss.driver_leagues.role, the same table the rest
// of the app uses — NOT pitboss.licences, which is unused/legacy).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

// role is stored as free text, sometimes a comma-separated list
// (e.g. "head_steward, bsac_chief, team_principal"), so we match
// on substring rather than exact equality.
const STEWARD_ROLE_TOKENS = ['steward', 'bsac_chief', 'commissioner']

function hasStewardRole(role: string | null | undefined): boolean {
  if (!role) return false
  const normalized = role.toLowerCase()
  return STEWARD_ROLE_TOKENS.some(token => normalized.includes(token))
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const status   = req.nextUrl.searchParams.get('status') ?? 'open'

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Resolve driver from Discord ID
  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', session.user.discordId)
    .single()

  if (!driver) {
    return NextResponse.json({ error: 'Driver record not found' }, { status: 403 })
  }

  // Check steward-level role in this league via driver_leagues
  // (same table the rest of the app uses for role checks)
  const { data: driverLeague } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .single()

  if (!hasStewardRole(driverLeague?.role)) {
    return NextResponse.json({ error: 'Steward access required' }, { status: 403 })
  }

  // Fetch incidents
  const { data: incidents, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select(`
      id,
      incident_type,
      description,
      status,
      verdict,
      penalty,
      penalty_points,
      season,
      round,
      lap,
      evidence_urls,
      ai_verdict,
      ai_points,
      ai_confidence,
      ai_analysed_at,
      created_at,
      reported_by,
      accused_driver_id
    `)
    .eq('league_id', leagueId)
    .eq('status', status)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ incidents: incidents ?? [] })
}
