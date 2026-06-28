import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'
import { pbSteward } from '@/lib/pitboss-llm'
import type { RuleArticle } from '@/lib/pitboss-llm'

const STEWARD_ROLES = ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM']
const STEWARD_LEAGUE_ROLES = ['co_owner', 'commissioner', 'head_steward']

async function getRequestingDriver(supabase: any, session: any) {
  const user = session.user as any
  const discordId: string | undefined = user.discordId ?? user.discord_id ?? user.id
  const email: string | undefined = user.email ?? undefined

  let driver = null

  if (discordId) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id')
      .eq('discord_id', discordId)
      .maybeSingle()
    driver = data
  }

  if (!driver && email) {
    const { data } = await supabase
      .schema('pitboss')
      .from('drivers')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    driver = data
  }

  return driver
}

async function hasStewwardAccess(supabase: any, driverId: string, leagueId: string): Promise<boolean> {
  const { data: licence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)
    .eq('status', 'active')
    .in('role_code', STEWARD_ROLES)
    .maybeSingle()

  if (licence) return true

  const { data: leagueRole } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)
    .in('role', STEWARD_LEAGUE_ROLES)
    .maybeSingle()

  return !!leagueRole
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (error) {
    console.error('[incidents/id GET] fetch', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isParty =
    incident.reported_by === requestingDriver.id ||
    incident.accused_driver_id === requestingDriver.id ||
    incident.resolved_by === requestingDriver.id

  if (!isSteward && !isParty) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: reporter } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, discord_username, display_name, discord_avatar')
    .eq('id', incident.reported_by)
    .maybeSingle()

  const { data: accused } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, discord_username, display_name, discord_avatar')
    .eq('id', incident.accused_driver_id)
    .maybeSingle()

  const { data: league } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', incident.league_id)
    .maybeSingle()

  return NextResponse.json({
    incident: { ...incident, reporter, accused, league },
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const body = await req.json()
  const { action } = body

  const { data: incident, error: incError } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()

  if (incError || !incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  if (!isSteward) {
    return NextResponse.json({ error: 'Forbidden — steward access required' }, { status: 403 })
  }

  // ── Action: resolve ──────────────────────────────────────────────────────
  if (action === 'resolve') {
    const {
      verdict,
      penalty         = null,
      penalty_points  = 0,
      steward_notes   = null,
      override_reason = null,
    } = body

    if (!verdict) {
      return NextResponse.json({ error: 'verdict is required' }, { status: 400 })
    }

    const now = new Date().toISOString()

    const { error: updateError } = await supabase
      .schema('pitboss')
      .from('incidents')
      .update({
        status:          'resolved',
        verdict,
        penalty,
        penalty_points,
        steward_notes,
        override_reason,
        resolved_by:     requestingDriver.id,
        resolved_at:     now,
      })
      .eq('id', params.id)

    if (updateError) {
      console.error('[incidents/id POST] resolve update', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    if (verdict === 'guilty' && penalty_points > 0 && incident.accused_driver_id) {
      const { error: ledgerError } = await supabase
        .schema('pitboss')
        .from('penalty_ledger')
        .insert({
          driver_id:   incident.accused_driver_id,
          league_id:   incident.league_id,
          incident_id: incident.id,
          points:      penalty_points,
          reason:      penalty ?? `Incident: ${incident.incident_type}`,
          issued_at:   now,
          issued_by:   requestingDriver.id,
          source:      'steward_ruling',
        })

      if (ledgerError) {
        console.error('[incidents/id POST] penalty ledger insert', ledgerError)
      }
    }

    return NextResponse.json({ success: true })
  }

  // ── Action: analyse ──────────────────────────────────────────────────────
  if (action === 'analyse') {
    const { data: articles } = await supabase
      .schema('pitboss')
      .from('rule_articles')
      .select('article_number, title, body, category, league_id, rule_book_id')
      .eq('league_id', incident.league_id)
      .eq('active', true)
      .order('article_number', { ascending: true })

    const regulations: RuleArticle[] = (articles ?? []).map((a: any) => ({
      article_number: a.article_number,
      title:          a.title,
      body:           a.body,
      category:       a.category     ?? '',
      league_id:      a.league_id    ?? incident.league_id,
      rule_book_id:   a.rule_book_id ?? '',
    }))

    try {
      const ai = await pbSteward(
        {
          incident_type: incident.incident_type,
          description:   incident.description,
          season:        incident.season,
          round:         incident.round,
          lap:           incident.lap,
          league_id:     incident.league_id,
        },
        regulations,
        incident.league_id
      )

      if ('error' in ai) {
        console.error('[incidents/id POST] pbSteward error', ai)
        return NextResponse.json({ error: ai.error }, { status: 502 })
      }

      const suggestion = ai.suggestion

      const confidenceMap: Record<string, number> = {
        high: 0.9, medium: 0.6, low: 0.3,
      }

      const { error: aiUpdateError } = await supabase
        .schema('pitboss')
        .from('incidents')
        .update({
          ai_verdict:     suggestion.verdict                   ?? null,
          ai_penalty:     suggestion.steward_notes             ?? null,
          ai_points:      suggestion.pp_recommendation?.min    ?? 0,
          ai_confidence:  confidenceMap[suggestion.confidence] ?? 0.5,
          ai_reasoning:   suggestion.reasoning                 ?? null,
          ai_articles:    suggestion.cited_articles            ?? [],
          ai_model:       ai.model                             ?? 'unknown',
          ai_analysed_at: new Date().toISOString(),
        })
        .eq('id', params.id)

      if (aiUpdateError) {
        console.error('[incidents/id POST] ai update', aiUpdateError)
        return NextResponse.json({ error: aiUpdateError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    } catch (err: any) {
      console.error('[incidents/id POST] ai analyse', err)
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
