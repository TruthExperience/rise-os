import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { session_id, question_id, selected_answer, is_correct, next_index } = body

  if (!session_id || !question_id || selected_answer === undefined) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: session, error: fetchErr } = await supabase
    .from('exam_sessions')
    .select('answers, question_ids, status, expires_at')
    .eq('id', session_id)
    .single()

  if (fetchErr || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.status !== 'active') {
    return NextResponse.json({ error: 'Session is no longer active' }, { status: 409 })
  }

  if (new Date(session.expires_at) < new Date()) {
    await supabase
      .from('exam_sessions')
      .update({ status: 'expired' })
      .eq('id', session_id)
    return NextResponse.json({ error: 'Session expired' }, { status: 410 })
  }

  const updatedAnswers = [
    ...session.answers,
    { question_id, selected_answer, is_correct },
  ]

  const { error: updateErr } = await supabase
    .from('exam_sessions')
    .update({
      answers: updatedAnswers,
      current_index: next_index,
      last_active_at: new Date().toISOString(),
    })
    .eq('id', session_id)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, answers_saved: updatedAnswers.length })
}

export async function PUT(req: NextRequest) {
  const body = await req.json()
  const { session_id } = body

  if (!session_id) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: session, error: fetchErr } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('id', session_id)
    .single()

  if (fetchErr || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const correct = session.answers.filter((a: any) => a.is_correct).length
  const total = session.question_ids.length
  const score = total > 0 ? Math.round((correct / total) * 100) : 0

  const { data: cert } = await supabase
    .from('certifications')
    .select('pass_mark')
    .eq('id', session.certification_id)
    .single()

  const passMark = cert?.pass_mark ?? 95
  const passed = score >= passMark
  const now = new Date().toISOString()

  await supabase
    .from('exam_sessions')
    .update({ status: 'completed', completed_at: now, last_active_at: now })
    .eq('id', session_id)

  await supabase
    .from('certifications')
    .update({
      status: passed ? 'passed' : 'failed',
      score,
      completed_at: now,
      locked_until: passed ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', session.certification_id)

  return NextResponse.json({ ok: true, score, passed, correct, total })
}
