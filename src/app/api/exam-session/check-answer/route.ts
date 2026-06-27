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
  const questionId = req.nextUrl.searchParams.get('question_id')
  const answer = req.nextUrl.searchParams.get('answer')

  if (!questionId || answer === null) {
    return NextResponse.json({ error: 'question_id and answer required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: q, error } = await supabase
    .from('questions')
    .select('correct_answer')
    .eq('id', questionId)
    .single()

  if (error || !q) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 })
  }

  return NextResponse.json({
    is_correct: q.correct_answer === answer,
  })
}
