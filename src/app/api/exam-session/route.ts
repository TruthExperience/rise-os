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

// Loads the certification and confirms it belongs to the signed-in driver.
// Same ownership rule as /api/pitboss/cert/submit.
async function loadOwnCertification(supabase: any, certificationId: string, driverId: string) {
  const { data: cert, error } = await supabase
    .from('certifications')
    .select('id, driver_id, league_id, role_code, status')
    .eq('id', certificationId)
    .maybeSingle()

  if (error) {
    return { error: NextResponse.json({ error: error.message }, { status: 500 }) }
  }
  if (!cert) {
    return { error: NextResponse.json({ error: 'Certification not found' }, { status: 404 }) }
  }
  if (cert.driver_id !== driverId) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { cert }
}

export async function GET(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const certificationId = req.nextUrl.searchParams.get('certification_id')
  if (!certificationId) {
    return NextResponse.json({ error: 'certification_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const own = await loadOwnCertification(supabase, certificationId, driver.id)
  if (own.error) return own.error

  const { data: session, error } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('certification_id', certificationId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!session) {
    return NextResponse.json({ session: null })
  }

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('id, question, options, category, difficulty')
    .in('id', session.question_ids)

  if (qErr) {
    return NextResponse.json({ error: qErr.message }, { status: 500 })
  }

  const questionMap = Object.fromEntries(questions!.map((q: any) => [q.id, q]))
  const orderedQuestions = session.question_ids.map((id: string) => questionMap[id]).filter(Boolean)

  // Don't send per-answer correctness back to the exam taker mid-exam.
  const answers = (session.answers ?? []).map((a: any) => ({
    question_id: a.question_id,
    selected_answer: a.selected_answer,
  }))

  return NextResponse.json({
    session: {
      ...session,
      answers,
      questions: orderedQuestions,
    },
  })
}

export async function POST(req: NextRequest) {
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

  // driver_id, league_id and role_code in the request body are ignored.
  // They come from the signed-in driver and the certification row.
  const certification_id = body?.certification_id
  if (!certification_id || typeof certification_id !== 'string') {
    return NextResponse.json({ error: 'certification_id required' }, { status: 400 })
  }

  const supabase = getSupabase()

  const own = await loadOwnCertification(supabase, certification_id, driver.id)
  if (own.error) return own.error
  const cert = own.cert

  if (cert.status === 'passed' || cert.status === 'failed') {
    return NextResponse.json(
      { error: `Certification is already ${cert.status}` },
      { status: 409 }
    )
  }

  const league_id = cert.league_id
  const role_code = cert.role_code

  // If the driver already has a live session for this certification, hand it
  // back instead of drawing a new set. Before, calling POST again threw the
  // session away and drew fresh questions, so anyone could re-roll the draw
  // as often as they liked and read through the whole question pool.
  const { data: liveSession } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('certification_id', certification_id)
    .eq('driver_id', driver.id)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (liveSession) {
    const { data: liveQs } = await supabase
      .from('questions')
      .select('id, question, options, category, difficulty')
      .in('id', liveSession.question_ids)
    const byId = Object.fromEntries((liveQs ?? []).map((q: any) => [q.id, q]))
    return NextResponse.json({
      session: {
        ...liveSession,
        // no per-answer correctness mid-exam
        answers: (liveSession.answers ?? []).map((a: any) => ({
          question_id: a.question_id,
          selected_answer: a.selected_answer,
        })),
        questions: liveSession.question_ids.map((id: string) => byId[id]).filter(Boolean),
      },
    })
  }

  // Anything still marked active here is past its expiry.
  await supabase
    .from('exam_sessions')
    .update({ status: 'expired' })
    .eq('certification_id', certification_id)
    .eq('status', 'active')

  const { data: roleReq, error: rrErr } = await supabase
    .from('role_requirements')
    .select('question_count')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .maybeSingle()

  if (rrErr || !roleReq) {
    return NextResponse.json({ error: 'Role requirements not found' }, { status: 404 })
  }

  const { data: allQuestions, error: qErr } = await supabase
    .from('questions')
    .select('id, question, options, category, difficulty')
    .eq('league_id', league_id)
    .eq('role_code', role_code)
    .eq('active', true)

  if (qErr || !allQuestions?.length) {
    return NextResponse.json({ error: 'No questions available' }, { status: 404 })
  }

  // Fisher-Yates. sort(() => Math.random() - 0.5) is a biased shuffle.
  const shuffled = [...allQuestions]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const drawn = shuffled.slice(0, roleReq.question_count)
  const questionIds = drawn.map((q: any) => q.id)

  await supabase
    .from('certifications')
    .update({ status: 'in_progress', started_at: new Date().toISOString() })
    .eq('id', certification_id)

  const { data: session, error: sErr } = await supabase
    .from('exam_sessions')
    .insert({
      certification_id,
      driver_id: driver.id,
      league_id,
      question_ids: questionIds,
      answers: [],
      current_index: 0,
      status: 'active',
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single()

  if (sErr) {
    return NextResponse.json({ error: sErr.message }, { status: 500 })
  }

  return NextResponse.json({
    session: {
      ...session,
      questions: drawn,
    },
  })
}
