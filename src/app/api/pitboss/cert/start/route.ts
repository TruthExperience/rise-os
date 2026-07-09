import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()

  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
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

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[cert/start] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }
  if (['suspended', 'revoked'].includes(driver.super_licence_status)) {
    return NextResponse.json(
      { error: `Cannot sit certification — super licence is ${driver.super_licence_status}` },
      { status: 403 }
    )
  }

  // Note: pitboss.leagues, not rise_os.leagues — cert data (questions, role_requirements)
  // lives in the pitboss schema and is keyed off pitboss.leagues.id.
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

  // Enrollment check — driver must actually belong to this league.
  // Without this, any driver row (regardless of league) could pass an
  // arbitrary league_id from the request body and sit that league's exam.
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
    return NextResponse.json(
      { error: 'Driver not enrolled in this league' },
      { status: 403 }
    )
  }

  // Role requirements — question_count and pass_mark are role+league specific
  // (e.g. WSC Steward is 25 questions at 90%, WSC Driver is 20 at 90%).
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
    .select('id, status, locked_until, attempt_number')
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
      return NextResponse.json(
        { error: 'Locked out', locked_until: latest.locked_until },
        { status: 423 }
      )
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
    return NextResponse.json(
      { error: 'No questions available for this role' },
      { status: 422 }
    )
  }

  const attemptNumber = latest ? latest.attempt_number + 1 : 1

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
    })
    .select('id, started_at, pass_mark, attempt_number, role_code')
    .single()

  if (certError || !cert) {
    console.error('[cert/start] insert', certError)
    return NextResponse.json({ error: 'Failed to start certification' }, { status: 500 })
  }

  const sanitized = shuffle(questions)
    .slice(0, requirement.question_count)
    .map((q) => ({
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
