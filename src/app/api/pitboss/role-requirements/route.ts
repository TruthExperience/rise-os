import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const league_id = new URL(req.url).searchParams.get('league_id')
  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('role_code, role_name, question_count, pass_mark, description')
    .eq('league_id', league_id)
    .order('role_code')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: data ?? [] })
}
