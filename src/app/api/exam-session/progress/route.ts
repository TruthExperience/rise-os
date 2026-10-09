// src/app/api/exam-session/progress/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

export const dynamic = 'force-dynamic'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'pitboss' } }
  )
}

// Looks up the question's correct answer on the server. Correctness is
// never taken from the request.
async function lookupCorrectAnswers(supabase: any, questionIds: string[]) {
  const { data } = await supabase
    .from('questions')
    .select('id, correct_answer')
    .in('id', questionIds)
  const map: Record<string, string> = {}
  for (const q of data ?? []) map[q.id] = q.correct_answer
  return map
}

export async function PATCH(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  // is_correct and next_index in the body are ignored on purpose.
  const { session_id, question_id, selected_answer } = body ?? {}

  if (!session_id || !question_id || typeof selected_answer !== 'string') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = getSupabase()

  const { data: session, error: fetchErr } = await supabase
    .from('exam_sessions')
    .select('driver_id, answers, question_ids, status, expires_at, current_index')
    .eq('id', session_id)
    .single()

  if (fetchErr || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.driver_id !== driver.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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

  if (!session.question_ids.includes(question_id)) {
    return NextResponse.json({ error: 'Question is not part of this exam' }, { status: 400 })
  }

  // Idempotency guard: if this question was already answered (e.g. client retry
  // due to a flaky connection), don't double-record it — just return current state.
  const alreadyAnswered = session.answers.some(
    (a: any) => a.question_id === question_id
  )
  if (alreadyAnswered) {
    return NextResponse.json({
      ok: true,
      answers_saved: session.answers.length,
      current_index: session.current_index,
      duplicate: true,
    })
  }

  const correctMap = await lookupCorrectAnswers(supabase, [question_id])
  const is_correct = correctMap[question_id] === selected_answer

  const updatedAnswers = [
    ...session.answers,
    { question_id, selected_answer, is_correct },
  ]

  // current_index is always derived server-side from answers.length —
  // never trusted from the client. This is what fixes the repeat-question bug.
  const nextIndex = updatedAnswers.length

  const { error: updateErr } = await supabase
    .from('exam_sessions')
    .update({
      answers: updatedAnswers,
      current_index: nextIndex,
      last_active_at: new Date().toISOString(),
    })
    .eq('id', session_id)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    answers_saved: updatedAnswers.length,
    current_index: nextIndex,
  })
}

export async function PUT(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { session_id } = body ?? {}

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

  if (session.driver_id !== driver.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (session.status !== 'active' && session.status !== 'completed') {
    return NextResponse.json({ error: `Session is ${session.status}` }, { status: 409 })
  }

  const { data: cert } = await supabase
    .from('certifications')
    .select('pass_mark, status')
    .eq('id', session.certification_id)
    .single()

  // Grade from the stored answers, checked against the question bank
  // here. Any is_correct value saved earlier is not used.
  const correctMap = await lookupCorrectAnswers(supabase, session.question_ids)
  const correct = (session.answers ?? []).filter(
    (a: any) =>
      session.question_ids.includes(a.question_id) &&
      correctMap[a.question_id] !== undefined &&
      correctMap[a.question_id] === a.selected_answer
  ).length
  const total = session.question_ids.length
  const score = total > 0 ? Math.round((correct / total) * 100) : 0

  const passMark = cert?.pass_mark ?? 95
  const passed = score >= passMark

  // A retry after the exam was already graded returns the same result
  // without writing anything again.
  if (session.status === 'completed') {
    return NextResponse.json({ ok: true, score, passed, correct, total })
  }

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
      locked_until: passed
        ? null
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', session.certification_id)

  return NextResponse.json({ ok: true, score, passed, correct, total })
}
