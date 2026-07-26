import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Lazy singleton — constructed on first use inside a handler, not at
// module load. Avoids "supabaseUrl is required" during Next.js's
// build-time page-data collection.
let _supabase: any = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabase
}

export async function GET(req: NextRequest) {
  const supabase = getSupabase()
  const leagueId = req.nextUrl.searchParams.get('league_id')
  let query = supabase
    .schema('pitboss')
    .from('role_requirements')
    .select(`
      id,
      pass_mark,
      question_count,
      role_code,
      role_name,
      description,
      league_id,
      league:league_id ( id, name, slug )
    `)
  if (leagueId) {
    query = query.eq('league_id', leagueId)
  }
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ requirements: data })
}
