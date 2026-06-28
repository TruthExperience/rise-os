import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getServerSession } from 'next-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const league_id = searchParams.get('league_id');
  const status    = searchParams.get('status') ?? 'open';

  if (!league_id) return NextResponse.json({ error: 'league_id required' }, { status: 400 });

  const { data, error } = await supabase
    .schema('pitboss')
    .from('incidents')
    .select(`
      id, league_id, incident_type, description, status,
      season, round, lap, evidence_urls,
      ai_verdict, ai_penalty, ai_points, ai_confidence, ai_analysed_at,
      verdict, penalty, penalty_points, steward_notes,
      created_at, resolved_at,
      reported_by, accused_driver_id
    `)
    .eq('league_id', league_id)
    .eq('status', status)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ incidents: data });
}
