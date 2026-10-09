// src/app/api/pitboss/rule-articles/route.ts
// GET: fetch all active rule articles for a league

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

export async function GET(req: NextRequest) {
  const leagueId = req.nextUrl.searchParams.get('league_id')

  if (!leagueId) {
    return NextResponse.json({ error: 'league_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: articles, error } = await supabase
    .from('rule_articles')
    .select('id, article_number, title, body, category')
    .eq('league_id', leagueId)
    .eq('active', true)
    .order('article_number', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ articles: articles ?? [] })
}
