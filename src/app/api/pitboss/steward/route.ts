// src/app/api/pitboss/steward/route.ts
// GET — returns incidents for a league, filtered by status.
// Only accessible to users with a steward-level licence in that league.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF']

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

  // Check steward licence in this league
  const { data: licence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLES)
    .limit(1)
    .single()

  if (!licence) {
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
