import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/app/api/auth/[...nextauth]/route'
import { createClient } from '@/lib/supabase/server'

const CERT_WINDOW_MS = 60 * 60 * 1000
const LOCKOUT_HOURS  = 24

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  let body: { certification_id: string; answers: Record<string, string> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { certification_id, answers } = body
  if (!certification_id || !answers || typeof answers !== 'object') {
    return NextResponse.json(
      { error: 'certification_id and answers are required' },
      { status: 400 }
    )
  }

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[cert/submit] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, status, started_at, pass_mark, attempt_number')
    .eq('id', certification_id)
    .maybeSingle()

  if (certError) {
    console.error('[cert/submit] cert lookup', certError)
    return NextResponse.json({ error: certError.message }, { status: 500 })
  }
  if (!cert) {
    return NextResponse.json({ error: 'Certification not found' }, { status: 404 })
  }
  if (cert.driver_id !== driver.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (cert.status !== 'in_progress') {
    return NextResponse.json(
      { error: `Certification is already ${cert.status}` },
      { status: 409 }
    )
  }

  const now     = new Date()
  const elapsed = now.getTime() - new Date(cert.started_at).getTime()

  if (elapsed > CERT_WINDOW_MS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_HOURS * 60 * 60 * 1000)
    await supabase
      .schema('pitboss')
      .from('certifications')
      .update({ status: 'failed', score: 0, completed_at: now.toISOString(), locked_until: lockedUntil.toISOString() })
      .eq('id', certification_id)
    return NextResponse.json(
      { error: 'Time expired — certification failed', locked_until: lockedUntil.toISOString() },
      { status: 422 }
    )
  }

  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer')
    .eq('league_id', cert.league_id)
    .eq('active', true)

  if (questionsError || !questions) {
    console.error('[cert/submit] questions fetch', questionsError)
    return NextResponse.json({ error: 'Failed to fetch questions' }, { status: 500 })
  }

  const total   = questions.length
  let   correct = 0
  const breakdown: Record<string, { correct: boolean; correct_answer: string }> = {}

  for (const q of questions) {
    const submitted = answers[q.id] ?? null
    const isCorrect = submitted === q.correct_answer
    if (isCorrect) correct++
    breakdown[q.id] = { correct: isCorrect, correct_answer: q.correct_answer }
  }

  const score  = total > 0 ? Math.round((correct / total) * 100 * 100) / 100 : 0
  const passed = score >= Number(cert.pass_mark)

  if (passed) {
    const token = crypto.randomUUID()

    await supabase.schema('pitboss').from('certifications')
      .update({ status: 'passed', score, completed_at: now.toISOString(), token })
      .eq('id', certification_id)

    await supabase.schema('pitboss').from('driver_leagues')
      .update({ certified: true, certified_at: now.toISOString() })
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)

    const { data: league } = await supabase
      .schema('rise_os').from('leagues')
      .select('name').eq('id', cert.league_id).maybeSingle()

    const { data: seqRow } = await supabase
      .schema('pitboss').from('licence_sequences')
      .select('id, last_number')
      .eq('league_id', cert.league_id)
      .eq('role_code', 'driver')
      .maybeSingle()

    let nextNumber: number
    if (!seqRow) {
      nextNumber = 1
      await supabase.schema('pitboss').from('licence_sequences')
        .insert({ league_id: cert.league_id, role_code: 'driver', last_number: 1 })
    } else {
      nextNumber = seqRow.last_number + 1
      await supabase.schema('pitboss').from('licence_sequences')
        .update({ last_number: nextNumber }).eq('id', seqRow.id)
    }

    const licenceNumber = `DRV-${String(nextNumber).padStart(5, '0')}`

    const { data: newLicence } = await supabase
      .schema('pitboss').from('licences')
      .insert({
        driver_id:      driver.id,
        league_id:      cert.league_id,
        licence_number: licenceNumber,
        role_code:      'driver',
        title:          `${league?.name ?? 'League'} Driver`,
        status:         'active',
      })
      .select('id, licence_number')
      .single()

    return NextResponse.json({
      passed:         true,
      score,
      pass_mark:      cert.pass_mark,
      correct,
      total,
      token,
      licence_number: newLicence?.licence_number ?? null,
      licence_id:     newLicence?.id ?? null,
      breakdown,
    })
  } else {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_HOURS * 60 * 60 * 1000)

    await supabase.schema('pitboss').from('certifications')
      .update({ status: 'failed', score, completed_at: now.toISOString(), locked_until: lockedUntil.toISOString() })
      .eq('id', certification_id)

    return NextResponse.json({
      passed:       false,
      score,
      pass_mark:    cert.pass_mark,
      correct,
      total,
      missed_by:    Math.round((Number(cert.pass_mark) - score) * 100) / 100,
      locked_until: lockedUntil.toISOString(),
      breakdown,
    })
  }
}
