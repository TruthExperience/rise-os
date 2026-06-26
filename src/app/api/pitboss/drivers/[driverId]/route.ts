// src/app/api/pitboss/drivers/[driverId]/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type Params = { params: { driverId: string } }

const VALID_TIERS          = ['academy', 'apex', 'apex_pro', 'elite'] as const
const VALID_SUPER_STATUSES = ['active', 'review', 'suspended', 'revoked'] as const

// ─── GET — full driver profile ────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  const { driverId } = params

  // Verify driver exists before running parallel queries
  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('*')
    .eq('id', driverId)
    .single()

  if (driverError || !driver) {
    return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
  }

  // Parallel fetch all domains
  const [
    { data: gamertags },
    { data: driverLeagues },
    { data: licences },
    { data: certifications },
    { data: penalties },
    { data: incidentsAs },      // incidents where driver is the subject
    { data: incidentsReported }, // incidents the driver filed
    { data: contracts },
    { data: results },
  ] = await Promise.all([
    supabase
      .schema('pitboss')
      .from('driver_gamertags')
      .select('*')
      .eq('driver_id', driverId)
      .order('is_primary', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('driver_leagues')
      .select('*')
      .eq('driver_id', driverId),

    supabase
      .schema('pitboss')
      .from('licences')
      .select('id, licence_number, role_code, title, tier, era_endorsements, status, issued_at, expires_at, league_id')
      .eq('driver_id', driverId)
      .order('issued_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('certifications')
      .select('id, league_id, status, score, pass_mark, attempt_number, started_at, completed_at, locked_until')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('penalty_ledger')
      .select('id, league_id, points, reason, issued_at, expires_at, incident_id')
      .eq('driver_id', driverId)
      .order('issued_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('incidents')
      .select('id, league_id, status, incident_type, description, created_at, resolved_at')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('incidents')
      .select('id, league_id, status, incident_type, description, created_at, resolved_at')
      .eq('reporting_driver_id', driverId)
      .order('created_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('driver_contracts')
      .select('*')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false }),

    supabase
      .schema('pitboss')
      .from('results')
      .select('id, league_id, race_name, season, round, quali_pos, finish_pos, dnf, fastest_lap, points, created_at')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false }),
  ])

  // ── Enrich driver_leagues with rise_os.leagues (cross-schema fallback) ──────
  const leagueIds = [...new Set([
    ...(driverLeagues ?? []).map((dl: any) => dl.league_id),
    ...(licences ?? []).map((l: any) => l.league_id),
    ...(certifications ?? []).map((c: any) => c.league_id),
  ].filter(Boolean))]

  let leagueMap: Record<string, any> = {}

  if (leagueIds.length) {
    const { data: leagues } = await supabase
      .schema('rise_os')
      .from('leagues')
      .select('id, name, slug, sport, logo_url, discord_server_id')
      .in('id', leagueIds)

    for (const league of leagues ?? []) {
      leagueMap[league.id] = league
    }
  }

  const enrichedLeagues = (driverLeagues ?? []).map((dl: any) => ({
    ...dl,
    league: leagueMap[dl.league_id] ?? null,
  }))

  const enrichedLicences = (licences ?? []).map((l: any) => ({
    ...l,
    league: leagueMap[l.league_id] ?? null,
  }))

  const enrichedCerts = (certifications ?? []).map((c: any) => ({
    ...c,
    league: leagueMap[c.league_id] ?? null,
  }))

  // ── Penalty summary ──────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const allPenalties = penalties ?? []
  const activePenalties = allPenalties.filter(
    (p: any) => !p.expires_at || p.expires_at > now
  )
  const active_pp = activePenalties.reduce((sum: number, p: any) => sum + (p.points ?? 0), 0)

  // ── Results summary ──────────────────────────────────────────────────────────
  const allResults = results ?? []
  const resultsSummary = {
    starts:       allResults.length,
    wins:         allResults.filter((r: any) => r.finish_pos === 1).length,
    podiums:      allResults.filter((r: any) => r.finish_pos != null && r.finish_pos <= 3).length,
    dnfs:         allResults.filter((r: any) => r.dnf).length,
    fastest_laps: allResults.filter((r: any) => r.fastest_lap).length,
    points_total: allResults.reduce((sum: number, r: any) => sum + (r.points ?? 0), 0),
  }

  // ── Certification summary ────────────────────────────────────────────────────
  const certSummary = {
    total:       enrichedCerts.length,
    passed:      enrichedCerts.filter((c: any) => c.status === 'passed').length,
    in_progress: enrichedCerts.filter((c: any) => c.status === 'in_progress').length,
    failed:      enrichedCerts.filter((c: any) => c.status === 'failed').length,
    locked:      enrichedCerts.filter((c: any) => c.locked_until && c.locked_until > now).length,
  }

  return NextResponse.json({
    driver,
    gamertags:     gamertags ?? [],
    leagues:       enrichedLeagues,
    licences:      enrichedLicences,
    certifications: {
      summary: certSummary,
      list:    enrichedCerts,
    },
    penalties: {
      active:    activePenalties,
      active_pp,
      history:   allPenalties,
    },
    incidents: {
      as_subject:   incidentsAs ?? [],
      as_reporter:  incidentsReported ?? [],
      total:        (incidentsAs?.length ?? 0) + (incidentsReported?.length ?? 0),
    },
    contracts:     contracts ?? [],
    results: {
      summary: resultsSummary,
      recent:  allResults.slice(0, 10),
    },
  })
}

// ─── PATCH — update driver fields ─────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { driverId } = params
  const body = await req.json()
  const { display_name, tier, super_licence_status, era_endorsements, pp_total } = body

  if (tier !== undefined && !VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `tier must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }

  if (super_licence_status !== undefined && !VALID_SUPER_STATUSES.includes(super_licence_status)) {
    return NextResponse.json(
      { error: `super_licence_status must be one of: ${VALID_SUPER_STATUSES.join(', ')}` },
      { status: 400 }
    )
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (display_name       !== undefined) updates.display_name       = display_name
  if (tier               !== undefined) updates.tier               = tier
  if (super_licence_status !== undefined) updates.super_licence_status = super_licence_status
  if (era_endorsements   !== undefined) updates.era_endorsements   = era_endorsements
  if (pp_total           !== undefined) updates.pp_total           = pp_total

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('drivers')
    .update(updates)
    .eq('id', driverId)
    .select()
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
    }
    console.error('[drivers/[driverId]:PATCH]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
