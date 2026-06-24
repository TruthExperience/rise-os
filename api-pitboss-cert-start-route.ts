import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const PASS_MARKS: Record<string, number> = {
  trl: 95,
  wsc: 90,
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── POST /api/pitboss/cert/start ─────────────────────────────────────────────
// Body: { league_id: string }
// Returns: certification_id, started_at, pass_mark, questions (no correct_answer)
// Server owns started_at — client timer is display only.
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  let body: { league_id: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { league_id } = body
  if (!league_id) {
    return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  }

  // ── Resolve driver from session ──────────────────────────────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = user.user_metadata?.provider_id ?? user.user_metadata?.sub ?? ''

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[POST /api/pitboss/cert/start] driver lookup', driverError)
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

  // ── Resolve league ───────────────────────────────────────────────────────────
  const { data: league, error: leagueError } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', league_id)
    .maybeSingle()

  if (leagueError) {
    console.error('[POST /api/pitboss/cert/start] league lookup', leagueError)
    return NextResponse.json({ error: leagueError.message }, { status: 500 })
  }
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 })
  }

  // ── Lockout / duplicate checks ───────────────────────────────────────────────
  const now = new Date()

  const { data: latest } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, status, locked_until, attempt_number')
    .eq('driver_id', driver.id)
    .eq('league_id', league_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latest) {
    if (latest.status === 'passed') {
      return NextResponse.json({ error: 'Already certified for this league' }, { status: 409 })
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

  // ── Fetch questions ──────────────────────────────────────────────────────────
  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, category, question, options, difficulty')
    .eq('league_id', league_id)
    .eq('active', true)

  if (questionsError) {
    console.error('[POST /api/pitboss/cert/start] questions lookup', questionsError)
    return NextResponse.json({ error: questionsError.message }, { status: 500 })
  }
  if (!questions || questions.length === 0) {
    return NextResponse.json({ error: 'No questions available for this league' }, { status: 422 })
  }

  // ── Create certification row ─────────────────────────────────────────────────
  const passMark = PASS_MARKS[league.slug] ?? 90
  const attemptNumber = latest ? latest.attempt_number + 1 : 1

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .insert({
      driver_id:      driver.id,
      league_id,
      status:         'in_progress',
      pass_mark:      passMark,
      started_at:     now.toISOString(),
      attempt_number: attemptNumber,
    })
    .select('id, started_at, pass_mark, attempt_number')
    .single()

  if (certError || !cert) {
    console.error('[POST /api/pitboss/cert/start] insert', certError)
    return NextResponse.json({ error: 'Failed to start certification' }, { status: 500 })
  }

  // ── Strip correct_answer, shuffle both questions and each option set ─────────
  const sanitized = shuffle(questions).map((q) => ({
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
    total_questions:  sanitized.length,
    league:           { id: league.id, name: league.name, slug: league.slug },
    questions:        sanitized,
  })
}
