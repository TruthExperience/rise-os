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

const DRIVER_ROLE_CODES = new Set(['DRV'])

const LICENCE_TITLES: Record<string, string> = {
  DRV:  'Driver',
  STW:  'Steward',
  TP:   'Team Principal',
  BSAC: 'BSAC Officer',
  CRRB: 'CRRB Officer',
  SLB:  'SLB Officer',
  TWG:  'TWG Officer',
  COM:  'Commissioner',
}

export async function POST(req: NextRequest) {
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

  if (driverError) return NextResponse.json({ error: driverError.message }, { status: 500 })
  if (!driver) return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })

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

  // ── Load certification (role_code lives on the row) ─────────────────────────
  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, role_code, status, pass_mark, started_at, attempt_number')
    .eq('id', certification_id)
    .eq('driver_id', driver.id)
    .maybeSingle()

  if (certError) return NextResponse.json({ error: certError.message }, { status: 500 })
  if (!cert) return NextResponse.json({ error: 'Certification not found' }, { status: 404 })
  if (cert.status !== 'in_progress') {
    return NextResponse.json(
      { error: `Certification is already ${cert.status}` },
      { status: 409 }
    )
  }

  const roleCode = cert.role_code ?? 'DRV'

  // ── Load questions for this specific role only ───────────────────────────────
  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer, explanation')
    .eq('league_id', cert.league_id)
    .eq('role_code', roleCode)
    .eq('active', true)

  if (questionsError) return NextResponse.json({ error: questionsError.message }, { status: 500 })
  if (!questions || questions.length === 0) {
    return NextResponse.json({ error: 'No questions found for this certification' }, { status: 422 })
  }

  // ── Grade only questions that were in this exam ──────────────────────────────
  const answeredIds = new Set(Object.keys(answers))
  const questionsToGrade = questions.filter((q) => answeredIds.has(q.id))
    .concat(questions.filter((q) => !answeredIds.has(q.id)))
    .slice(0, questions.length)

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
  const totalQuestions = breakdown.length
  const score          = Math.round((correctCount / totalQuestions) * 100 * 100) / 100
  const passed         = score >= Number(cert.pass_mark)
  const now            = new Date()

  let lockedUntil: string | null = null
  if (!passed) {
    const hours    = LOCKOUT_HOURS[cert.attempt_number] ?? DEFAULT_LOCKOUT_HOURS
    const lockDate = new Date(now.getTime() + hours * 60 * 60 * 1000)
    lockedUntil    = lockDate.toISOString()
  }

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
    return NextResponse.json({ error: 'Failed to save certification result' }, { status: 500 })
  }

  if (passed) {
    // Only update driver_leagues.certified for actual driver exams
    if (DRIVER_ROLE_CODES.has(roleCode)) {
      await supabase
        .schema('pitboss')
        .from('driver_leagues')
        .update({ certified: true, certified_at: now.toISOString() })
        .eq('driver_id', driver.id)
        .eq('league_id', cert.league_id)
    }

    // Issue the correct licence type for this role
    const { data: existingLicence } = await supabase
      .schema('pitboss')
      .from('licences')
      .select('id')
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)
      .eq('role_code', roleCode)
      .maybeSingle()

    if (!existingLicence) {
      const { error: licenceError } = await supabase.rpc('issue_licence', {
        p_driver_id:  driver.id,
        p_league_id:  cert.league_id,
        p_role_code:  roleCode,
        p_title:      LICENCE_TITLES[roleCode] ?? roleCode,
        p_tier:       DRIVER_ROLE_CODES.has(roleCode) ? null : 'staff',
        p_photo_url:  null,
        p_expires_at: null,
      })

      if (licenceError) {
        console.error('[POST /api/pitboss/cert/submit] issue_licence error', licenceError)
      }
    }
  }

  return NextResponse.json({
    certification_id,
    role_code:       roleCode,
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
