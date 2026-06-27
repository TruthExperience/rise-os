// app/api/exam-session/route.ts
// GET  → check for an active session for a given certification
// POST → start a new session (draws questions, creates session row)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

// ─── GET: check for active session ───────────────────────────────────────────
export async function GET(req: NextRequest) {
  const certificationId = req.nextUrl.searchParams.get('certification_id')
  if (!certificationId) {
    return NextResponse.json({ error: 'certification_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: session, error } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('certification_id', certificationId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!session) {
    return NextResponse.json({ session: null })
  }

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('id, question, options, category, difficulty')
    .in('id', session.question_ids)

  if (qErr) {
    return NextResponse.json({ error: qErr.message }, { status: 500 })
  }

  const questionMap = Object.fromEntries(questions!.map((q: any) => [q.id, q]))
  const orderedQuestions = session.question_ids.map((id: string) => questionMap[id]).filter(Boolean)

  return NextResponse.json({
    session: {
      ...session,
      questions: orderedQuestions,
    },
  })
}

// ─── POST: start a new exam session ─────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { certification_id, driver_id, league_id, role_code } = body

  if (!certification_id || !driver_id || !league_id || !role_code) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = getSupabase()

  await supabase
    .from('exam_sessions')
    .update({ status: 'abandoned' })
    .eq('certification_id', certification_id)
    .eq('status', 'active')

  const { data: roleReq, error: rrErr } = await supabase
    .from('role_requirements')
    .select('question_count')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  if (rrErr || !roleReq) {
    return NextResponse.json({ error: 'Role requirements not found' }, { status: 404 })
  }

  const { data: allQuestions, error: qErr } = await supabase
    .from('questions')
    .select('id, question, options, category, difficulty')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .eq('active', true)

  if (qErr || !allQuestions?.length) {
    return NextResponse.json({ error: 'No questions available' }, { status: 404 })
  }

  const shuffled = allQuestions.sort(() => Math.random() - 0.5)
  const drawn = shuffled.slice(0, roleReq.question_count)
  const questionIds = drawn.map((q: any) => q.id)

  await supabase
    .from('certifications')
    .update({ status: 'in_progress', started_at: new Date().toISOString() })
    .eq('id', certification_id)

  const { data: session, error: sErr } = await supabase
    .from('exam_sessions')
    .insert({
      certification_id,
      driver_id,
      league_id,
      question_ids: questionIds,
      answers: [],
      current_index: 0,
      status: 'active',
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single()

  if (sErr) {
    return NextResponse.json({ error: sErr.message }, { status: 500 })
  }

  return NextResponse.json({
    session: {
      ...session,
      questions: drawn,
    },
  })
}
