// src/app/api/pitboss/verify/[token]/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — resolve token, start cert if pending, return questions
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { token } = params

  const { data: cert, error } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('*, drivers(display_name, discord_username), leagues:league_id(name, slug)')
    .eq('token', token)
    .single()

  if (error || !cert) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
  }

  // Already finished
  if (cert.status === 'passed' || cert.status === 'failed') {
    return NextResponse.json({
      status: cert.status,
      score: cert.score,
      pass_mark: cert.pass_mark,
      completed_at: cert.completed_at,
    })
  }

  // Locked out (failed previously, cooling down)
  if (cert.locked_until && new Date(cert.locked_until) > new Date()) {
    return NextResponse.json(
      {
        error: 'Certification locked',
        locked_until: cert.locked_until,
        attempt_number: cert.attempt_number,
      },
      { status: 423 }
    )
  }

  // Transition pending → in_progress
  if (cert.status === 'pending') {
    await supabase
      .schema('pitboss')
      .from('certifications')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', cert.id)
  }

  // Fetch active questions for this league
  const { data: questions } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, category, question, options, difficulty')
    .eq('league_id', cert.league_id)
    .eq('active', true)
    .order('difficulty')

  return NextResponse.json({
    cert_id: cert.id,
    status: 'in_progress',
    attempt_number: cert.attempt_number,
    pass_mark: cert.pass_mark,
    driver: cert.drivers,
    league: cert.leagues,
    questions: questions ?? [],
  })
}

// POST — submit answers, score, update status
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { token } = params
  const body = await req.json()
  const answers: Record<string, string> = body.answers // { question_id: selected_answer }

  if (!answers || typeof answers !== 'object') {
    return NextResponse.json({ error: 'answers object required' }, { status: 400 })
  }

  const { data: cert, error } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('*')
    .eq('token', token)
    .eq('status', 'in_progress')
    .single()

  if (error || !cert) {
    return NextResponse.json({ error: 'No active certification found for this token' }, { status: 404 })
  }

  // Fetch correct answers
  const questionIds = Object.keys(answers)
  const { data: questions } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer, explanation')
    .in('id', questionIds)

  if (!questions?.length) {
    return NextResponse.json({ error: 'No matching questions found' }, { status: 400 })
  }

  // Score
  let correct = 0
  const breakdown = questions.map((q) => {
    const submitted = answers[q.id]
    const isCorrect = submitted === q.correct_answer
    if (isCorrect) correct++
    return {
      question_id: q.id,
      correct: isCorrect,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
    }
  })

  const score = (correct / questions.length) * 100
  const passed = score >= Number(cert.pass_mark)
  const now = new Date().toISOString()

  // Lock on failure: 24h per attempt, capped at 72h
  const lockHours = Math.min(24 * cert.attempt_number, 72)
  const locked_until = passed
    ? null
    : new Date(Date.now() + lockHours * 60 * 60 * 1000).toISOString()

  await supabase
    .schema('pitboss')
    .from('certifications')
    .update({
      status: passed ? 'passed' : 'failed',
      score,
      completed_at: now,
      locked_until,
      attempt_number: cert.attempt_number + (passed ? 0 : 1),
    })
    .eq('id', cert.id)

  // If passed, mark driver as certified in driver_leagues
  if (passed) {
    await supabase
      .schema('pitboss')
      .from('driver_leagues')
      .update({ certified: true, certified_at: now })
      .eq('driver_id', cert.driver_id)
      .eq('league_id', cert.league_id)
  }

  return NextResponse.json({
    passed,
    score: Math.round(score * 100) / 100,
    pass_mark: cert.pass_mark,
    correct,
    total: questions.length,
    breakdown,
    ...(passed ? {} : { locked_until, next_attempt: cert.attempt_number + 1 }),
  })
}
