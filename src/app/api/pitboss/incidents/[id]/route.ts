import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/server'
import { pbSteward, pbInfer } from '@/lib/pitboss-llm'
import type { RuleArticle } from '@/lib/pitboss-llm'
import { getRequestingDriver, hasStewwardAccess } from '@/lib/pitboss/stewardAccess'


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

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession()
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

  const isSteward  = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isAccused  = incident.accused_driver_id === requestingDriver.id
  const isReporter = incident.reported_by === requestingDriver.id
  const isParty    = isAccused || isReporter || incident.resolved_by === requestingDriver.id

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
    .schema('pitboss')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', incident.league_id)
    .maybeSingle()

  // One appeal per incident, ever — fetch it if it exists so the client can
  // render appeal status / review UI without a second round trip.
  const { data: appeal } = await supabase
    .schema('pitboss')
    .from('incident_appeals')
    .select('*')
    .eq('incident_id', incident.id)
    .maybeSingle()

  return NextResponse.json({
    incident:   { ...incident, reporter, accused, league },
    isAccused,
    isSteward,
    isReporter,
    appeal: appeal ?? null,
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: incident } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('id, accused_driver_id, status, league_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  if (incident.status === 'resolved') {
    return NextResponse.json({ error: 'Cannot respond to a resolved incident' }, { status: 409 })
  }

  const isSteward = await hasStewwardAccess(supabase, requestingDriver.id, incident.league_id)
  const isAccused = incident.accused_driver_id === requestingDriver.id

  if (!isAccused && !isSteward) {
    return NextResponse.json(
      { error: 'Only the accused driver or a steward can submit a defence' },
      { status: 403 }
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const accused_response = typeof body?.accused_response === 'string' ? body.accused_response : ''
  const accused_evidence_urls = cleanUrls(body?.accused_evidence_urls)

  if (!accused_response.trim()) {
    return NextResponse.json({ error: 'Response cannot be empty' }, { status: 400 })
  }
  if (accused_response.length > 5000) {
    return NextResponse.json({ error: 'Response is too long (max 5000 characters)' }, { status: 400 })
  }
  if (accused_evidence_urls === 'invalid') {
    return NextResponse.json({ error: 'Evidence links must be http(s) URLs (max 10)' }, { status: 400 })
  }

  const { error: updateError } = await supabase
    .schema('pitboss')
    .from('incidents')
    .update({
      accused_response:      accused_response.trim(),
      accused_evidence_urls: accused_evidence_urls,
      accused_response_at:   new Date().toISOString(),
    })
    .eq('id', params.id)

  if (updateError) {
    console.error('[incidents/id PATCH]', updateError)
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getSession()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const requestingDriver = await getRequestingDriver(supabase, session)

  if (!requestingDriver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { action } = body ?? {}

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

    if (!verdict || typeof verdict !== 'string' || verdict.length > 50) {
      return NextResponse.json({ error: 'verdict is required' }, { status: 400 })
    }
    if (typeof penalty_points !== 'number' || !Number.isFinite(penalty_points) || penalty_points < 0 || penalty_points > 1000) {
      return NextResponse.json({ error: 'penalty_points must be a number between 0 and 1000' }, { status: 400 })
    }
    for (const [k, v] of [['penalty', penalty], ['steward_notes', steward_notes], ['override_reason', override_reason]] as const) {
      if (v != null && (typeof v !== 'string' || v.length > 4000)) {
        return NextResponse.json({ error: `${k} must be text under 4000 characters` }, { status: 400 })
      }
    }

    // Conflict of interest: a steward can't rule on an incident filed against them.
    if (incident.accused_driver_id === requestingDriver.id) {
      return NextResponse.json(
        { error: 'A steward cannot rule on an incident filed against them' },
        { status: 403 }
      )
    }

    const now = new Date().toISOString()

    // Only an unresolved incident can be resolved here, and only one request
    // wins. Before, a second resolve (double tap, retry) wrote a second
    // penalty_ledger row. Overturning a ruling goes through the appeal flow.
    const { data: resolvedRow, error: updateError } = await supabase
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
      .neq('status', 'resolved')
      .neq('status', 'appealed')
      .select('id')
      .maybeSingle()

    if (updateError) {
      console.error('[incidents/id POST] resolve update', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
    if (!resolvedRow) {
      return NextResponse.json({ error: 'This incident has already been resolved' }, { status: 409 })
    }

    if (verdict === 'guilty' && penalty_points > 0 && incident.accused_driver_id) {
      // pp_total is NOT written here — pitboss.fn_recalc_driver_pp_total()
      // recomputes drivers.pp_total automatically via trg_penalty_ledger_pp_total
      // the moment this insert lands. Do not add a manual pp_total update.
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
          source:      'incident',
        })

      if (ledgerError) {
        console.error('[incidents/id POST] penalty ledger insert', ledgerError)
        return NextResponse.json(
          { error: 'Incident was resolved, but penalty ledger entry failed: ' + ledgerError.message },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true })
  }

  // ── Action: analyse ──────────────────────────────────────────────────────
  if (action === 'analyse') {
    // Each analyse costs two LLM calls. Block repeat runs within 30s so a
    // double tap or script can't spam them.
    const lastRun = incident.ai_analysed_at ? new Date(incident.ai_analysed_at).getTime() : 0
    if (Date.now() - lastRun < 30_000) {
      return NextResponse.json({ error: 'Analysis was just run. Wait a moment and try again.' }, { status: 429 })
    }

    const { data: articles } = await supabase
      .schema('pitboss')
      .from('rule_articles')
      .select(`
        article_number, title, body, category, league_id, rule_book_id,
        rule_references (
          penalty_min_pp,
          penalty_max_pp,
          penalty_options,
          incident_types,
          enforcement_body,
          fine_min_trl,
          fine_max_trl
        )
      `)
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

    const penaltyRanges: Record<string, { min: number; max: number; options: string[] }> = {}
    for (const a of articles ?? []) {
      for (const ref of a.rule_references ?? []) {
        if (!ref.incident_types) continue
        for (const incType of ref.incident_types) {
          if (!penaltyRanges[incType] || ref.penalty_min_pp != null) {
            penaltyRanges[incType] = {
              min:     ref.penalty_min_pp ?? 0,
              max:     ref.penalty_max_pp ?? ref.penalty_min_pp ?? 0,
              options: ref.penalty_options ?? [],
            }
          }
        }
      }
    }

    // Pull steward discussion into AI context
    const { data: comments } = await supabase
      .schema('pitboss')
      .from('incident_steward_comments')
      .select('body, drivers(display_name, discord_username)')
      .eq('incident_id', params.id)
      .order('created_at', { ascending: true })

    const stewardDiscussion = (comments ?? [])
      .map((c: any) => `${c.drivers?.display_name ?? c.drivers?.discord_username ?? 'Steward'}: ${c.body}`)
      .join('\n')

    try {
      const ai = await pbSteward(
        {
          incident_type:      incident.incident_type,
          description:        incident.description,
          season:             incident.season,
          round:              incident.round,
          lap:                incident.lap,
          league_id:          incident.league_id,
          accused_response:   incident.accused_response ?? undefined,
          evidence_urls:      incident.evidence_urls ?? [],
          steward_discussion: stewardDiscussion || undefined,
          penalty_ranges:     penaltyRanges,
          applicable_range:   penaltyRanges[incident.incident_type] ?? null,
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

      let penaltyExplanation: string | null = null
      try {
        const expl = await pbInfer({
          mode: 'primary',
          system:
            'Write a short, clear, neutral explanation of this incident ruling for the affected ' +
            'driver and league to read. Plain language, no rule-article numbers, no steward jargon.',
          prompt: [
            `Incident: ${incident.incident_type} — ${incident.description}`,
            `Verdict: ${suggestion.verdict ?? 'unresolved'}`,
            `Reasoning: ${suggestion.reasoning ?? ''}`,
            stewardDiscussion ? `Steward discussion:\n${stewardDiscussion}` : '',
          ].filter(Boolean).join('\n\n'),
          max_tokens: 400,
          temperature: 0.4,
        })
        penaltyExplanation = expl.response ?? null
      } catch (explErr) {
        console.error('[incidents/id POST] explanation infer failed', explErr)
      }

      const { error: aiUpdateError } = await supabase
        .schema('pitboss')
        .from('incidents')
        .update({
          ai_verdict:                suggestion.verdict                   ?? null,
          ai_penalty:                suggestion.steward_notes             ?? null,
          ai_points:                 suggestion.pp_recommendation?.min    ?? 0,
          ai_confidence:             confidenceMap[suggestion.confidence] ?? 0.5,
          ai_reasoning:              suggestion.reasoning                 ?? null,
          ai_articles:               suggestion.cited_articles            ?? [],
          ai_model:                  ai.model                             ?? 'unknown',
          ai_analysed_at:            new Date().toISOString(),
          ai_penalty_explanation:    penaltyExplanation,
          ai_penalty_explanation_at: penaltyExplanation ? new Date().toISOString() : null,
        })
        .eq('id', params.id)

      if (aiUpdateError) {
        console.error('[incidents/id POST] ai update', aiUpdateError)
        return NextResponse.json({ error: aiUpdateError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, penalty_explanation: penaltyExplanation })
    } catch (err: any) {
      console.error('[incidents/id POST] ai analyse', err)
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
