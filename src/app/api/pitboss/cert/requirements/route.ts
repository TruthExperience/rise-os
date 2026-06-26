import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const { data, error } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select(`
      id,
      pass_mark,
      question_count,
      role_code,
      league_id,
      leagues:rise_os.leagues!league_id ( id, name, slug )
    `)
    .eq('role_code', 'DRV')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ requirements: data })
}
