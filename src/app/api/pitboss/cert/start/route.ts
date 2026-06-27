import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
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

  let body: { league_id: string; role_code: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { league_id, role_code } = body
  if (!league_id) return NextResponse.json({ error: 'league_id is required' }, { status: 400 })
  if (!role_code) return NextResponse.json({ error: 'role_code is required' }, { status: 400 })

  // ── Driver lookup ──────────────────────────────────────────────────────────
  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, super_licence_status')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) return NextResponse.json({ error: driverError.message }, { status: 500 })
  if (!driver) return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  if (['suspended', 'revoked'].includes(driver.super_licence_status)) {
    return NextResponse.json(
      { error: `Cannot sit certification — super licence is ${driver.super_licence_status}` },
      { status: 403 }
    )
  }

  // ── League lookup ──────────────────────────────────────────────────────────
  const { data: league, error: leagueError } = await supabase
    .schema('rise_os')
    .from('leagues')
    .select('id, name, slug')
    .eq('id', league_id)
    .maybeSingle()

  if (leagueError) return NextResponse.json({ error: leagueError.message }, { status: 500 })
  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 })

  // ── Role requirements — pass mark and question count from DB ───────────────
  const { data: roleReq, error: roleReqError } = await supabase
    .schema('pitboss')
    .from('role_requirements')
    .select('pass_mark, question_count, role_name')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  if (roleReqError) return NextResponse.json({ error: roleReqError.message }, { status: 500 })
  if (!roleReq) {
    return NextResponse.json(
      { error: `No exam defined for role '${role_code}' in this league` },
      { status: 404 }
    )
  }

  // ── Check existing cert for this specific role ─────────────────────────────
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
      return NextResponse.json(
        { error: `Already certified for ${roleReq.role_name ?? role_code}` },
        { status: 409 }
      )
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

  // ── Fetch questions for this specific role ─────────────────────────────────
  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, category, question, options, difficulty')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .eq('active', true)

  if (questionsError) return NextResponse.json({ error: questionsError.message }, { status: 500 })
  if (!questions || questions.length === 0) {
    return NextResponse.json(
      { error: `No questions available for ${roleReq.role_name ?? role_code} exam` },
      { status: 422 }
    )
  }

  const attemptNumber = latest ? latest.attempt_number + 1 : 1

  // ── Create cert row with role_code ─────────────────────────────────────────
  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .insert({
      driver_id:      driver.id,
      league_id,
      role_code,
      status:         'in_progress',
      pass_mark:      roleReq.pass_mark,
      started_at:     now.toISOString(),
      attempt_number: attemptNumber,
    })
    .select('id, started_at, pass_mark, attempt_number')
    .single()

  if (certError || !cert) {
    return NextResponse.json({ error: 'Failed to start certification' }, { status: 500 })
  }

  // ── Shuffle and trim to required question count ────────────────────────────
  const drawn = shuffle(questions).slice(0, roleReq.question_count)
  const sanitized = drawn.map((q) => ({
    id:         q.id,
    category:   q.category,
    question:   q.question,
    options:    shuffle(Object.values(q.options as Record<string, string>)),
    difficulty: q.difficulty,
  }))

  return NextResponse.json({
    certification_id: cert.id,
    started_at:       cert.started_at,
    pass_mark:        cert.pass_mark,
    attempt_number:   cert.attempt_number,
    total_questions:  sanitized.length,
    role_code,
    role_name:        roleReq.role_name,
    league:           { id: league.id, name: league.name, slug: league.slug },
    questions:        sanitized,
  })
}
