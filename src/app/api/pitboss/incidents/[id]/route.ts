import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: requestingDriver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

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
    console.error('[incidents/id] fetch', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  const { data: stewardLicence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', requestingDriver.id)
    .eq('league_id', incident.league_id)
    .eq('status', 'active')
    .in('role_code', ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM'])
    .maybeSingle()

  const allowed =
    !!stewardLicence ||
    incident.reported_by === requestingDriver.id ||
    incident.accused_driver_id === requestingDriver.id ||
    incident.resolved_by === requestingDriver.id

  if (!allowed) {
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
    incident: {
      ...incident,
      reporter,
      accused,
      league,
    },
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

  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: requestingDriver } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

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

  const { data: stewardLicence } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id')
    .eq('driver_id', requestingDriver.id)
    .eq('league_id', incident.league_id)
    .eq('status', 'active')
    .in('role_code', ['STW', 'HEAD_STW', 'BSAC_CHIEF', 'COMMISSIONER', 'ADMIN', 'COM'])
    .maybeSingle()

  if (!stewardLicence) {
    return NextResponse.json({ error: 'Forbidden — steward access required' }, { status: 403 })
  }

  // ── Action: resolve ─────────────────────────────────────────────────────
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
      console.error('[incidents/id] resolve update', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // Write to penalty ledger if guilty and points > 0
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
        console.error('[incidents/id] penalty ledger insert', ledgerError)
      }
    }

    return NextResponse.json({ success: true })
  }

  // ── Action: analyse ─────────────────────────────────────────────────────
  if (action === 'analyse') {
    const { data: articles } = await supabase
      .schema('pitboss')
      .from('rule_articles')
      .select('article_number, title, content')
      .eq('league_id', incident.league_id)
      .eq('active', true)
      .order('article_number', { ascending: true })

    const rulebookText = articles && articles.length > 0
      ? articles.map((a: any) => `Article ${a.article_number} — ${a.title}:\n${a.content}`).join('\n\n')
      : 'No rulebook articles available for this league.'

    const prompt = `You are an AI steward for a sim racing league. Analyse this incident and provide a verdict.

INCIDENT TYPE: ${incident.incident_type}
DESCRIPTION: ${incident.description}
SEASON: ${incident.season ?? 'Unknown'}
ROUND: ${incident.round ?? 'Unknown'}
LAP: ${incident.lap ?? 'Unknown'}

RULEBOOK:
${rulebookText}

Respond with ONLY a JSON object in this exact format:
{
  "verdict": "guilty" | "not_guilty" | "inconclusive",
  "penalty": "string describing penalty or null",
  "points": number (0-12),
  "confidence": number (0.0-1.0),
  "reasoning": "string explaining the decision",
  "articles": ["Article X", "Article Y"]
}`

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          messages:   [{ role: 'user', content: prompt }],
        }),
      })

      const aiData = await aiRes.json()
      const raw    = aiData.content?.[0]?.text ?? ''
      const clean  = raw.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      const { error: aiUpdateError } = await supabase
        .schema('pitboss')
        .from('incidents')
        .update({
          ai_verdict:     parsed.verdict,
          ai_penalty:     parsed.penalty ?? null,
          ai_points:      parsed.points ?? 0,
          ai_confidence:  parsed.confidence ?? null,
          ai_reasoning:   parsed.reasoning ?? null,
          ai_articles:    parsed.articles ?? [],
          ai_model:       'claude-sonnet-4-6',
          ai_analysed_at: new Date().toISOString(),
        })
        .eq('id', params.id)

      if (aiUpdateError) {
        console.error('[incidents/id] ai update', aiUpdateError)
        return NextResponse.json({ error: aiUpdateError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    } catch (err: any) {
      console.error('[incidents/id] ai analyse', err)
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
