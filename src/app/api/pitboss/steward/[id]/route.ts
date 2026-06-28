import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSession } from 'next-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { action } = body;

  if (action === 'analyse') {
    const { data: incident, error: fetchErr } = await supabase
      .schema('pitboss')
      .from('incidents')
      .select('*')
      .eq('id', params.id)
      .single();

    if (fetchErr || !incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    const llmRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/pitboss/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'steward',
        league: incident.league_id,
        fetch_regulations: true,
        incident: {
          incident_type: incident.incident_type,
          description:   incident.description,
          season:        incident.season,
          round:         incident.round,
          lap:           incident.lap,
          league_id:     incident.league_id,
        },
      }),
    });

    if (!llmRes.ok) {
      return NextResponse.json({ error: 'AI analysis failed' }, { status: 502 });
    }

    const ai = await llmRes.json();
    const suggestion = ai.suggestion ?? {};

    const { error: updateErr } = await supabase
      .schema('pitboss')
      .from('incidents')
      .update({
        ai_verdict:     suggestion.verdict     ?? ai.verdict,
        ai_penalty:     suggestion.penalty     ?? ai.penalty,
        ai_points:      suggestion.points      ?? ai.points      ?? 0,
        ai_reasoning:   suggestion.reasoning   ?? ai.reasoning,
        ai_confidence:  suggestion.confidence  ?? ai.confidence  ?? 0,
        ai_articles:    suggestion.articles    ?? ai.articles    ?? [],
        ai_model:       ai.model,
        ai_analysed_at: new Date().toISOString(),
      })
      .eq('id', params.id);

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
    return NextResponse.json({ success: true, suggestion });
  }

  if (action === 'resolve') {
    const {
      verdict,
      penalty,
      penalty_points,
      steward_notes,
      override_reason,
      resolved_by,
    } = body;

    if (!verdict) return NextResponse.json({ error: 'verdict required' }, { status: 400 });

    const { data: incident } = await supabase
      .schema('pitboss')
      .from('incidents')
      .update({
        verdict,
        penalty:         penalty         ?? null,
        penalty_points:  penalty_points  ?? 0,
        steward_notes:   steward_notes   ?? null,
        override_reason: override_reason ?? null,
        status:          'resolved',
        resolved_by:     resolved_by,
        resolved_at:     new Date().toISOString(),
      })
      .eq('id', params.id)
      .select()
      .single();

    if (penalty_points > 0 && incident?.accused_driver_id) {
      await supabase
        .schema('pitboss')
        .from('penalty_ledger')
        .insert({
          driver_id:   incident.accused_driver_id,
          league_id:   incident.league_id,
          incident_id: params.id,
          points:      penalty_points,
          reason:      `${verdict} — ${penalty ?? 'Penalty issued'}`,
        });
    }

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
