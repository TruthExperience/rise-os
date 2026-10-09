// src/app/api/pitboss/verify/[token]/route.ts
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'

export const dynamic = 'force-dynamic'

const MAX_ANSWERS = 200

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// GET — resolve token, start cert if pending, return questions.
// The token alone is no longer enough: the caller must be signed in as the
// driver the certification was issued to. The /verify/[token] page is already
// behind login, so a legitimate driver is always signed in here.
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabase()
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

  if (cert.driver_id !== driver.id) {
    return NextResponse.json(
      { error: 'This certification belongs to a different driver' },
      { status: 403 }
    )
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

  // Transition pending → in_progress (only if still pending, so two tabs
  // can't both "start" it and reset started_at)
  if (cert.status === 'pending') {
    await supabase
      .schema('pitboss')
      .from('certifications')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', cert.id)
      .eq('status', 'pending')
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
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabase()
  const { token } = params

  let body: { answers?: Record<string, string> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const answers = body?.answers // { question_id: selected_answer }

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return NextResponse.json({ error: 'answers object required' }, { status: 400 })
  }
  if (Object.keys(answers).length > MAX_ANSWERS) {
    return NextResponse.json({ error: 'Too many answers' }, { status: 400 })
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

  if (cert.driver_id !== driver.id) {
    return NextResponse.json(
      { error: 'This certification belongs to a different driver' },
      { status: 403 }
    )
  }

  // Grade against the FULL active question set for this league, the same set
  // GET serves. Previously the score was calculated only over the question
  // ids the client chose to send, so answering one question correctly and
  // skipping the rest scored 100% and passed. Unanswered now counts as wrong,
  // and ids from other leagues or inactive questions are ignored.
  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer, explanation')
    .eq('league_id', cert.league_id)
    .eq('active', true)

  if (questionsError) {
    return NextResponse.json({ error: 'Failed to load questions' }, { status: 500 })
  }
  if (!questions?.length) {
    return NextResponse.json({ error: 'No active questions for this league' }, { status: 422 })
  }

  // Score
  let correct = 0
  const breakdown = questions.map((q) => {
    const submitted = answers[q.id]
    const isCorrect = typeof submitted === 'string' && submitted === q.correct_answer
    if (isCorrect) correct++
    return { question_id: q.id, isCorrect, correct_answer: q.correct_answer, explanation: q.explanation }
  })

  const score = (correct / questions.length) * 100
  const passed = score >= Number(cert.pass_mark)

  // Only a passing attempt gets the answer key and explanations back. A failed
  // attempt gets right/wrong per question, so it can't be used to learn the
  // answers for the retake.
  const clientBreakdown = breakdown.map((b) =>
    passed
      ? { question_id: b.question_id, correct: b.isCorrect, correct_answer: b.correct_answer, explanation: b.explanation }
      : { question_id: b.question_id, correct: b.isCorrect }
  )
  const now = new Date().toISOString()

  // Lock on failure: 24h per attempt, capped at 72h
  const lockHours = Math.min(24 * cert.attempt_number, 72)
  const locked_until = passed
    ? null
    : new Date(Date.now() + lockHours * 60 * 60 * 1000).toISOString()

  // Claim the result atomically: only the request that still sees
  // status = 'in_progress' wins, so a double-submit or two parallel requests
  // can't both grade (and can't both bump attempt_number).
  const { data: claimed, error: updateError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .update({
      status: passed ? 'passed' : 'failed',
      score: Math.round(score * 100) / 100,
      completed_at: now,
      locked_until,
      attempt_number: cert.attempt_number + (passed ? 0 : 1),
    })
    .eq('id', cert.id)
    .eq('status', 'in_progress')
    .select('id')

  if (updateError) {
    return NextResponse.json({ error: 'Failed to record result' }, { status: 500 })
  }
  if (!claimed?.length) {
    return NextResponse.json({ error: 'This certification was already submitted' }, { status: 409 })
  }

  // If passed, mark driver as certified in driver_leagues
  if (passed) {
    const { error: certifyError } = await supabase
      .schema('pitboss')
      .from('driver_leagues')
      .update({ certified: true, certified_at: now })
      .eq('driver_id', cert.driver_id)
      .eq('league_id', cert.league_id)
    if (certifyError) {
      console.error('[verify] failed to mark driver certified', certifyError.message)
    }
  }

  return NextResponse.json({
    passed,
    score: Math.round(score * 100) / 100,
    pass_mark: cert.pass_mark,
    correct,
    total: questions.length,
    breakdown: clientBreakdown,
    ...(passed ? {} : { locked_until, next_attempt: cert.attempt_number + 1 }),
  })
}
