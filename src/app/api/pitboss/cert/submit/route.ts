import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LOCKOUT_HOURS: Record<number, number> = {
  1: 24,
  2: 48,
  3: 72,
}
const DEFAULT_LOCKOUT_HOURS = 72

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const discordId = (session.user as any).discordId
  if (!discordId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[POST /api/pitboss/cert/submit] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { certification_id: string; answers: Record<string, string> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { certification_id, answers } = body

  if (!certification_id) {
    return NextResponse.json({ error: 'certification_id is required' }, { status: 400 })
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return NextResponse.json(
      { error: 'answers must be an object mapping question_id to selected option' },
      { status: 400 }
    )
  }

  // ── Load certification ──────────────────────────────────────────────────────
  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, status, pass_mark, started_at, attempt_number')
    .eq('id', certification_id)
    .eq('driver_id', driver.id)
    .maybeSingle()

  if (certError) {
    console.error('[POST /api/pitboss/cert/submit] cert lookup', certError)
    return NextResponse.json({ error: certError.message }, { status: 500 })
  }
  if (!cert) {
    return NextResponse.json({ error: 'Certification not found' }, { status: 404 })
  }
  if (cert.status !== 'in_progress') {
    return NextResponse.json(
      { error: `Certification is already ${cert.status}` },
      { status: 409 }
    )
  }

  // ── Load questions with correct_answer (server-only) ────────────────────────
  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer, explanation')
    .eq('league_id', cert.league_id)
    .eq('active', true)

  if (questionsError) {
    console.error('[POST /api/pitboss/cert/submit] questions lookup', questionsError)
    return NextResponse.json({ error: questionsError.message }, { status: 500 })
  }
  if (!questions || questions.length === 0) {
    return NextResponse.json({ error: 'No questions found for this certification' }, { status: 422 })
  }

  // ── Grade ───────────────────────────────────────────────────────────────────
  const breakdown = questions.map((q) => {
    const selected = answers[q.id] ?? null
    const correct  = selected === q.correct_answer
    return {
      question_id:    q.id,
      selected,
      correct_answer: q.correct_answer,
      correct,
      explanation:    q.explanation ?? null,
    }
  })

  const correctCount   = breakdown.filter((b) => b.correct).length
  const totalQuestions = questions.length
  const score          = Math.round((correctCount / totalQuestions) * 100 * 100) / 100
  const passed         = score >= Number(cert.pass_mark)
  const now            = new Date()

  // ── Lockout if failed ───────────────────────────────────────────────────────
  let lockedUntil: string | null = null
  if (!passed) {
    const hours    = LOCKOUT_HOURS[cert.attempt_number] ?? DEFAULT_LOCKOUT_HOURS
    const lockDate = new Date(now.getTime() + hours * 60 * 60 * 1000)
    lockedUntil    = lockDate.toISOString()
  }

  // ── Update certification row ────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .update({
      status:       passed ? 'passed' : 'failed',
      score,
      completed_at: now.toISOString(),
      locked_until: lockedUntil,
    })
    .eq('id', certification_id)

  if (updateError) {
    console.error('[POST /api/pitboss/cert/submit] cert update', updateError)
    return NextResponse.json({ error: 'Failed to save certification result' }, { status: 500 })
  }

  // ── On pass: update driver_leagues + auto-issue licence ────────────────────
  if (passed) {
    const { error: dlError } = await supabase
      .schema('pitboss')
      .from('driver_leagues')
      .update({ certified: true, certified_at: now.toISOString() })
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)

    if (dlError) {
      console.error('[POST /api/pitboss/cert/submit] driver_leagues update', dlError)
    }

    const { data: existingLicence } = await supabase
      .schema('pitboss')
      .from('licences')
      .select('id')
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)
      .maybeSingle()

    if (!existingLicence) {
      const { data: seq, error: seqError } = await supabase
        .schema('pitboss')
        .from('licence_sequences')
        .select('id, last_number')
        .eq('league_id', cert.league_id)
        .eq('role_code', 'DRV')
        .maybeSingle()

      if (!seqError && seq) {
        const nextNumber = seq.last_number + 1
        const licenceNum = `DRV-${String(nextNumber).padStart(4, '0')}`

        await supabase
          .schema('pitboss')
          .from('licence_sequences')
          .update({ last_number: nextNumber })
          .eq('id', seq.id)

        await supabase
          .schema('pitboss')
          .from('licences')
          .insert({
            driver_id:      driver.id,
            league_id:      cert.league_id,
            licence_number: licenceNum,
            role_code:      'DRV',
            title:          'Driver',
            status:         'active',
            issued_at:      now.toISOString(),
          })
      } else {
        console.warn('[POST /api/pitboss/cert/submit] no DRV sequence found for league', cert.league_id)
      }
    }
  }

  return NextResponse.json({
    certification_id,
    status:          passed ? 'passed' : 'failed',
    passed,
    score,
    pass_mark:       cert.pass_mark,
    correct_count:   correctCount,
    total_questions: totalQuestions,
    ...(lockedUntil ? { locked_until: lockedUntil } : {}),
    breakdown,
  })
}
