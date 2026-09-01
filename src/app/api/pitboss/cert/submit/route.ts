import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { regenerateQuestionPool } from '@/lib/pitboss/question-pool-regen'

const CERT_WINDOW_MS = 60 * 60 * 1000
const LOCKOUT_HOURS  = 24
const REGEN_EVERY_N  = 4

// Fires a pool regen once every REGEN_EVERY_N completed exams for this
// (league, role). Never awaited by the caller's response path — a slow or
// failing regen should never delay grading feedback to the driver.
async function maybeTriggerRegen(supabase: any, leagueId: string, roleCode: string) {
  const { count, error } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', leagueId)
    .eq('role_code', roleCode)
    .in('status', ['passed', 'failed'])

  if (error) {
    console.error('[cert/submit] regen count check failed', error)
    return
  }
  if (count && count % REGEN_EVERY_N === 0) {
    regenerateQuestionPool(leagueId, roleCode).catch((err) =>
      console.error('[cert/submit] question pool regen failed', err)
    )
  }
}

export async function POST(req: NextRequest) {
  const supabase = createAdminClient()

  const driver = await getAuthedDriver()
  if (!driver) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, role_code, status, started_at, pass_mark, attempt_number')
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

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

    return NextResponse.json(
      { error: 'Time expired — certification failed', locked_until: lockedUntil.toISOString() },
      { status: 422 }
    )
  }

  // Score only against the questions actually submitted (i.e. the ones the
  // driver was shown), scoped to this cert's role+league so answer keys
  // from another role/league can't be spoofed into the grading set.
  const submittedIds = Object.keys(answers)

  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer')
    .in('id', submittedIds)
    .eq('league_id', cert.league_id)
    .eq('role_code', cert.role_code)

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

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

    // Re-certification guard: a driver can retake and pass a role they're
    // already actively licenced for (e.g. sitting a fresh attempt after a
    // question pool regen). In that case reuse the existing active licence
    // instead of minting a duplicate licence_number — a pass should
    // reaffirm the current licence, not spawn a second one.
    const { data: existingLicence } = await supabase
      .schema('pitboss').from('licences')
      .select('id, licence_number')
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)
      .eq('role_code', cert.role_code)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let licenceNumber: string | null = existingLicence?.licence_number ?? null
    let licenceId:     string | null = existingLicence?.id ?? null

    if (!existingLicence) {
      const { data: league } = await supabase
        .schema('rise_os').from('leagues')
        .select('name').eq('id', cert.league_id).maybeSingle()

      const { data: roleReq } = await supabase
        .schema('pitboss').from('role_requirements')
        .select('role_name')
        .eq('league_id', cert.league_id)
        .eq('role_code', cert.role_code)
        .maybeSingle()

      const { data: seqRow } = await supabase
        .schema('pitboss').from('licence_sequences')
        .select('id, last_number')
        .eq('league_id', cert.league_id)
        .eq('role_code', cert.role_code)
        .maybeSingle()

      let nextNumber: number
      if (!seqRow) {
        nextNumber = 1
        await supabase.schema('pitboss').from('licence_sequences')
          .insert({ league_id: cert.league_id, role_code: cert.role_code, last_number: 1 })
      } else {
        nextNumber = seqRow.last_number + 1
        await supabase.schema('pitboss').from('licence_sequences')
          .update({ last_number: nextNumber }).eq('id', seqRow.id)
      }

      const newLicenceNumber = `${cert.role_code}-${String(nextNumber).padStart(5, '0')}`

      const { data: newLicence } = await supabase
        .schema('pitboss').from('licences')
        .insert({
          driver_id:      driver.id,
          league_id:      cert.league_id,
          licence_number: newLicenceNumber,
          role_code:      cert.role_code,
          title:          `${league?.name ?? 'League'} ${roleReq?.role_name ?? cert.role_code}`,
          status:         'active',
        })
        .select('id, licence_number')
        .single()

      licenceNumber = newLicence?.licence_number ?? newLicenceNumber
      licenceId     = newLicence?.id ?? null
    }

    return NextResponse.json({
      passed:         true,
      score,
      pass_mark:      cert.pass_mark,
      correct,
      total,
      token,
      licence_number: licenceNumber,
      licence_id:     licenceId,
      breakdown,
    })
  } else {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_HOURS * 60 * 60 * 1000)

    await supabase.schema('pitboss').from('certifications')
      .update({ status: 'failed', score, completed_at: now.toISOString(), locked_until: lockedUntil.toISOString() })
      .eq('id', certification_id)

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

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
