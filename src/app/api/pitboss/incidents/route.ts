// src/app/api/pitboss/incidents/route.ts
// POST — submit an incident report.
// Access rules:
//   TRL  → role must contain 'team_principal' or 'sporting_director'
//   WSC  → any driver in the league
//   AWC  → any driver in the league

import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { createClient } from '@supabase/supabase-js'
import { openDiscordIncidentTicket } from '@/lib/discord/app-sync'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

const TRL_LEAGUE_ID  = '3a005e8d-c35f-4a57-aa27-c59c0c3812e2'
const TRL_PRIVILEGED = ['team_principal', 'sporting_director', 'commissioner', 'head_steward']


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

export async function GET(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const supabase = getSupabase()

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
  const reporter = await getAuthedDriver()
  if (!reporter) {
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
    season,
    round,
    lap,
    evidence_urls: rawEvidenceUrls,
    accused_driver_id,
    accused_discord_username, // manual fallback
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

  const supabase = getSupabase()

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
    const roles = String(membership.role ?? '').split(',').map((r: string) => r.trim().toLowerCase())
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

  if (resolvedAccusedId) {
    const { data: accusedMember } = await supabase
      .from('driver_leagues')
      .select('driver_id')
      .eq('driver_id', resolvedAccusedId)
      .eq('league_id', league_id)
      .limit(1)
    if (!accusedMember?.length) {
      return NextResponse.json({ error: 'The accused driver is not a member of this league' }, { status: 400 })
    }
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
      evidence_urls: evidence_urls,
      status: 'open',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Mirror the incident into Discord (private incident-XXXX channel + DM to the
  // accused). Never throws; a Discord failure doesn't undo the report.
  const discord = await openDiscordIncidentTicket(incident.id)
  if (!discord.ok) {
    console.error('[incidents POST] discord sync', discord.error)
  }
  const channelId = discord.ok ? discord.channelId : null

  return NextResponse.json(
    {
      incident: { ...incident, ticket_channel_id: channelId ?? incident.ticket_channel_id ?? null },
      discord_ticket_channel_id: channelId,
    },
    { status: 201 }
  )
}
