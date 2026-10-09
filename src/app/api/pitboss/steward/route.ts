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
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/server'

// role is stored as free text, sometimes a comma-separated list
// (e.g. "head_steward, bsac_chief, team_principal"). Match each comma-separated
// role exactly. A substring match would also accept roles like
// "steward_applicant" or "assistant_commissioner_elect" the day one exists.
// These five tokens are exactly what the old substring check accepted for the
// roles in use today, so no current steward loses access.
const STEWARD_ROLE_TOKENS = ['steward', 'head_steward', 'bsac_chief', 'commissioner', 'co_commissioner']

function hasStewardRole(role: string | null | undefined): boolean {
  if (!role) return false
  return role
    .toLowerCase()
    .split(',')
    .map((r) => r.trim())
    .some((r) => STEWARD_ROLE_TOKENS.includes(r))
}

const MAX_URLS = 10
// Returns a cleaned string[] (or null when none), or 'invalid' if any entry is
// not an http(s) URL — keeps javascript:/data: links out of the incident record.
function cleanUrls(input: unknown): string[] | null | 'invalid' {
  if (input == null) return null
  if (!Array.isArray(input) || input.length > MAX_URLS) return 'invalid'
  const out: string[] = []
  for (const u of input) {
    if (typeof u !== 'string' || u.length > 2000) return 'invalid'
    try {
      const p = new URL(u.trim())
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return 'invalid'
      out.push(p.toString())
    } catch {
      return 'invalid'
    }
  }
  return out.length ? out : null
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
  const session = await getSession()
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
  const session = await getSession()
  if (!session?.user?.discordId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const {
    league_id,
    incident_type,
    description,
    accused_driver_id,
    reported_by,       // driver_id of whoever actually filed the report — may differ from the steward
    season,
    round,
    lap,
    evidence_urls: rawEvidenceUrls,
  } = body ?? {}

  if (!league_id || !incident_type || !description) {
    return NextResponse.json(
      { error: 'league_id, incident_type, and description are required' },
      { status: 400 }
    )
  }
  if (
    typeof league_id !== 'string' || typeof incident_type !== 'string' || typeof description !== 'string' ||
    incident_type.length > 100 || description.length > 5000
  ) {
    return NextResponse.json({ error: 'Invalid incident fields (description max 5000 characters)' }, { status: 400 })
  }
  for (const [k, v] of [['round', round], ['lap', lap]] as const) {
    if (v != null && v !== '' && !Number.isFinite(Number(v))) {
      return NextResponse.json({ error: `${k} must be a number` }, { status: 400 })
    }
  }
  const evidence_urls = cleanUrls(rawEvidenceUrls)
  if (evidence_urls === 'invalid') {
    return NextResponse.json({ error: 'Evidence links must be http(s) URLs (max 10)' }, { status: 400 })
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

  // Both the reporter and the accused must be members of THIS league. The old
  // check only confirmed the ids existed in pitboss.drivers, so a steward could
  // open a ticket against (or on behalf of) a driver from any league.
  const idsToValidate = [resolvedReportedBy, accused_driver_id].filter(Boolean) as string[]
  if (idsToValidate.length > 0) {
    const { data: members } = await supabase
      .schema('pitboss')
      .from('driver_leagues')
      .select('driver_id')
      .eq('league_id', league_id)
      .in('driver_id', idsToValidate)

    const memberIds = new Set((members ?? []).map((m) => m.driver_id))
    for (const checkId of idsToValidate) {
      if (!memberIds.has(checkId)) {
        return NextResponse.json({ error: `Driver ${checkId} is not a member of this league` }, { status: 400 })
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
      round: round != null && round !== '' ? Number(round) : null,
      lap: lap != null && lap !== '' ? Number(lap) : null,
      evidence_urls: evidence_urls ?? [],
      status: 'open',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ incident })
}
