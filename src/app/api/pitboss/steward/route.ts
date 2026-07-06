// src/app/api/pitboss/steward/route.ts
// GET  — returns incidents for a league, filtered by status.
// POST — opens a new incident ticket. Steward-only. Lets the filing steward
//        specify both who is accused and who submitted the original report,
//        rather than assuming the steward themself is the reporter.
//
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

async function resolveStewardDriver(supabase: ReturnType<typeof createAdminClient>, discordId: string, leagueId: string) {
  const { data: driver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .single()

  if (!driver) return { driver: null, isSteward: false }

  const { data: driverLeague } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .single()

  return { driver, isSteward: hasStewardRole(driverLeague?.role) }
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

  const { driver, isSteward } = await resolveStewardDriver(supabase, session.user.discordId, leagueId)

  if (!driver) {
    return NextResponse.json({ error: 'Driver record not found' }, { status: 403 })
  }
  if (!isSteward) {
    return NextResponse.json({ error: 'Steward access required' }, { status: 403 })
  }

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
    accused_driver_id,
    reported_by,       // driver_id of whoever actually filed the report — may differ from the steward
    season,
    round,
    lap,
    evidence_urls,
  } = body

  if (!league_id || !incident_type || !description) {
    return NextResponse.json(
      { error: 'league_id, incident_type, and description are required' },
      { status: 400 }
    )
  }

  const supabase = createAdminClient()

  const { driver: stewardDriver, isSteward } = await resolveStewardDriver(
    supabase,
    session.user.discordId,
    league_id
  )

  if (!stewardDriver) {
    return NextResponse.json({ error: 'Driver record not found' }, { status: 403 })
  }
  if (!isSteward) {
    return NextResponse.json({ error: 'Steward access required' }, { status: 403 })
  }

  // reported_by defaults to the filing steward only if not explicitly
  // provided — a steward opening a ticket on someone else's behalf should
  // always pass the actual reporter's driver_id.
  const resolvedReportedBy = reported_by || stewardDriver.id

  // Validate that both driver ids, if provided, actually belong to this league's
  // credential registry (drivers.discord_id -> credential_registry.discord_id),
  // so a ticket can't be opened against/on-behalf-of someone outside the league.
  const idsToValidate = [resolvedReportedBy, accused_driver_id].filter(Boolean)
  if (idsToValidate.length > 0) {
    const { data: validDrivers } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id, discord_id')
      .in('id', idsToValidate)

    const validIds = new Set((validDrivers ?? []).map((d) => d.id))
    for (const checkId of idsToValidate) {
      if (!validIds.has(checkId)) {
        return NextResponse.json({ error: `Invalid driver_id: ${checkId}` }, { status: 400 })
      }
    }
  }

  const { data: incident, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .insert({
      league_id,
      incident_type,
      description,
      accused_driver_id: accused_driver_id ?? null,
      reported_by: resolvedReportedBy,
      season: season ?? null,
      round: round ?? null,
      lap: lap ?? null,
      evidence_urls: evidence_urls ?? [],
      status: 'open',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ incident })
}
