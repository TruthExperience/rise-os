import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { createAdminClient } from '@/lib/supabase/server'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Rebuilds the same client payload shape from a cert's stored question_ids.
// Option order isn't persisted, so options are re-shuffled on every fetch —
// harmless since correctness doesn't depend on option order.
async function buildSessionPayload(
  supabase: any,
  cert: { id: string; started_at: string; pass_mark: number; attempt_number: number; role_code: string; question_ids: string[] },
  league: { id: string; name: string; slug: string },
  roleName: string
) {
  const { data: questions, error } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, category, question, options, difficulty')
    .in('id', cert.question_ids)

  if (error || !questions) return null

  const questionMap = new Map(questions.map((q: any) => [q.id, q]))
  const ordered = cert.question_ids
    .map((id) => questionMap.get(id))
    .filter(Boolean)
    .map((q: any) => ({
      id:         q.id,
      category:   q.category,
      question:   q.question,
      options:    shuffle(q.options as string[]),
      difficulty: q.difficulty,
    }))

  return {
    certification_id: cert.id,
    started_at:       cert.started_at,
    pass_mark:        cert.pass_mark,
    attempt_number:   cert.attempt_number,
    role_code:        cert.role_code,
    role_name:        roleName,
    total_questions:  ordered.length,
    league,
    questions:        ordered,
  }
}

type HistoryRow = { question_id: string; last_seen_at: string; seen_count: number }

// Draws a per-driver question set: unseen questions first, topped up with
// the driver's least-recently-seen ones if the unseen pool runs short.
// This is what makes rotation per-user rather than global — two drivers
// sitting the same role at the same time can get different sets even
// though they're drawing from the same active pool.
async function drawQuestionsForDriver(
  supabase: any,
  driverId: string,
  leagueId: string,
  roleCode: string,
  questions: Array<{ id: string; category: string; question: string; options: unknown; difficulty: string }>,
  questionCount: number
) {
  const { data: historyRows } = await supabase
    .schema('pitboss')
    .from('driver_question_history')
    .select('question_id, last_seen_at, seen_count')
    .eq('driver_id', driverId)
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)

  const historyMap = new Map<string, HistoryRow>(
    (historyRows ?? []).map((h: HistoryRow) => [h.question_id, h])
  )

  const unseen = questions.filter((q) => !historyMap.has(q.id))
  const seenOldestFirst = questions
    .filter((q) => historyMap.has(q.id))
    .sort(
      (a, b) =>
        new Date(historyMap.get(a.id)!.last_seen_at).getTime() -
        new Date(historyMap.get(b.id)!.last_seen_at).getTime()
    )

  let drawn: typeof questions
  if (unseen.length >= questionCount) {
    drawn = shuffle(unseen).slice(0, questionCount)
  } else {
    // Bank exhausted for this driver — cycle back through their oldest
    // seen questions rather than failing the draw.
    const needed = questionCount - unseen.length
    drawn = shuffle([...unseen, ...seenOldestFirst.slice(0, needed)])
  }

  return { drawn, historyMap }
}

async function recordQuestionHistory(
  supabase: any,
  driverId: string,
  leagueId: string,
  roleCode: string,
  drawnIds: string[],
  historyMap: Map<string, HistoryRow>
) {
  const nowIso = new Date().toISOString()
  const rows = drawnIds.map((qid) => ({
    driver_id:    driverId,
    league_id:    leagueId,
    role_code:    roleCode,
    question_id:  qid,
    last_seen_at: nowIso,
    seen_count:   (historyMap.get(qid)?.seen_count ?? 0) + 1,
  }))

  const { error } = await supabase
    .schema('pitboss')
    .from('driver_question_history')
    .upsert(rows, { onConflict: 'driver_id,league_id,role_code,question_id' })

  if (error) {
    // Non-fatal — worst case a driver sees a repeat sooner than intended.
    console.error('[cert/start] history upsert failed', error)
  }
}

// GET — resume an existing in_progress certification by ID alone.
// Used when the exam page's sessionStorage has been lost (app backgrounded,
// tab closed, page shared/reopened later).
export async function GET(req: NextRequest) {
  const supabase = createAdminClient()
  const certificationId = req.nextUrl.searchParams.get('certification_id')
  if (!certificationId) {
    return NextResponse.json({ error: 'certification_id is required' }, { status: 400 })
  }

  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, role_code, status, started_at, pass_mark, attempt_number, question_ids')
    .eq('id', certificationId)
    .maybeSingle()

  if (certError) {
    return NextResponse.json({ error: certError.message }, { status: 500 })
  }
  if (!cert || cert.driver_id !== driver.id) {
    return NextResponse.json({ error: 'Certification not found' }, { status: 404 })
  }
  if (cert.status !== 'in_progress') {
    return NextResponse.json({ error: `Certification is ${cert.status}, not in progress` }, { status: 409 })
  }
  if (!cert.question_ids || cert.question_ids.length === 0) {
    // Legacy row from before question_ids existed — can't be recovered.
    return NextResponse.json(
      { error: 'This attempt predates resume support and cannot be recovered. Please start a new attempt.' },
      { status: 410 }
    )
  }

  const { data: league } = await supabase
    .schema('pitboss').from('leagues')
    .select('id, name, slug').eq('id', cert.league_id).maybeSingle()

  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 })
  }

  const { data: requirement } = await supabase
    .schema('pitboss').from('role_requirements')
    .select('role_name')
    .eq('league_id', cert.league_id)
    .eq('role_code', cert.role_code)
    .maybeSingle()

  const payload = await buildSessionPayload(supabase, cert, league, requirement?.role_name ?? cert.role_code)
  if (!payload) {
    return NextResponse.json({ error: 'Failed to rebuild session' }, { status: 500 })
  }

  return NextResponse.json(payload)
}

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()

  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { league_id: string; role_code: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { league_id, role_code } = body
  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }
  if (!role_code) {
    return NextResponse.json({ error: 'role_code is required' }, { status: 400 })
  }

  if (['suspended', 'revoked'].includes(driver.superLicenceStatus)) {
    return NextResponse.json(
      { error: `Cannot sit certification — super licence is ${driver.superLicenceStatus}` },
      { status: 403 }
    )
  }

  const { data: league, error: leagueError } = await supabase
    .schema('pitboss')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', league_id)
    .maybeSingle()

  if (leagueError) {
    console.error('[cert/start] league lookup', leagueError)
    return NextResponse.json({ error: leagueError.message }, { status: 500 })
  }
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 })
  }

  const { data: enrollment, error: enrollmentError } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .maybeSingle()

  if (enrollmentError) {
    console.error('[cert/start] enrollment lookup', enrollmentError)
    return NextResponse.json({ error: enrollmentError.message }, { status: 500 })
  }
  if (!enrollment) {
    return NextResponse.json({ error: 'Driver not enrolled in this league' }, { status: 403 })
  }

  const { data: requirement, error: requirementError } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('question_count, pass_mark, role_name')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  if (requirementError) {
    console.error('[cert/start] role_requirements lookup', requirementError)
    return NextResponse.json({ error: requirementError.message }, { status: 500 })
  }
  if (!requirement) {
    return NextResponse.json(
      { error: `No certification defined for role ${role_code} in this league` },
      { status: 404 }
    )
  }

  const now = new Date()

  const { data: latest } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, status, locked_until, attempt_number, started_at, pass_mark, question_ids')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latest) {
    if (latest.status === 'passed') {
      return NextResponse.json({ error: 'Already certified for this role' }, { status: 409 })
    }
    if (latest.status === 'in_progress') {
      // Resumable: rebuild and return the existing session instead of blocking.
      if (latest.question_ids && latest.question_ids.length > 0) {
        const payload = await buildSessionPayload(
          supabase,
          { ...latest, id: latest.id } as any,
          league,
          requirement.role_name
        )
        if (payload) return NextResponse.json(payload)
      }
      // Legacy in_progress row with no stored questions — can't rebuild.
      return NextResponse.json(
        { error: 'Certification already in progress', certification_id: latest.id },
        { status: 409 }
      )
    }
    if (
      latest.status === 'failed' &&
      latest.locked_until &&
      new Date(latest.locked_until) > now
    ) {
      return NextResponse.json({ error: 'Locked out', locked_until: latest.locked_until }, { status: 423 })
    }
  }

  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, category, question, options, difficulty')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .eq('active', true)

  if (questionsError) {
    console.error('[cert/start] questions', questionsError)
    return NextResponse.json({ error: questionsError.message }, { status: 500 })
  }
  if (!questions || questions.length < requirement.question_count) {
    console.error(
      `[cert/start] insufficient bank for ${role_code}/${league_id}: ` +
      `have ${questions?.length ?? 0}, need ${requirement.question_count}`
    )
    return NextResponse.json({ error: 'No questions available for this role' }, { status: 422 })
  }

  const attemptNumber = latest ? latest.attempt_number + 1 : 1

  const { drawn, historyMap } = await drawQuestionsForDriver(
    supabase,
    driver.id,
    league_id,
    role_code,
    questions,
    requirement.question_count
  )
  const drawnIds = drawn.map((q) => q.id)

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .insert({
      driver_id:      driver.id,
      league_id,
      role_code,
      status:         'in_progress',
      pass_mark:      requirement.pass_mark,
      started_at:     now.toISOString(),
      attempt_number: attemptNumber,
      question_ids:   drawnIds,
    })
    .select('id, started_at, pass_mark, attempt_number, role_code')
    .single()

  if (certError || !cert) {
    console.error('[cert/start] insert', certError)
    return NextResponse.json({ error: 'Failed to start certification' }, { status: 500 })
  }

  // Record what this driver was shown so the next draw can rotate away
  // from it. Fire after the cert insert succeeds so a history-write
  // failure never blocks the exam from starting.
  await recordQuestionHistory(supabase, driver.id, league_id, role_code, drawnIds, historyMap)

  const sanitized = drawn.map((q) => ({
    id:         q.id,
    category:   q.category,
    question:   q.question,
    options:    shuffle(q.options as string[]),
    difficulty: q.difficulty,
  }))

  return NextResponse.json({
    certification_id: cert.id,
    started_at:       cert.started_at,
    pass_mark:        cert.pass_mark,
    attempt_number:   cert.attempt_number,
    role_code:        cert.role_code,
    role_name:        requirement.role_name,
    total_questions:  sanitized.length,
    league:           { id: league.id, name: league.name, slug: league.slug },
    questions:        sanitized,
  })
}
