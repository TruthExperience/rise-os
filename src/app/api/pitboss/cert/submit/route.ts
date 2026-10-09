import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedDriver } from '@/lib/getSupabaseUserId'
import { regenerateQuestionPool } from '@/lib/pitboss/question-pool-regen'
import { syncCertScoreToSheet } from '@/lib/pitboss/sheets-sync'
import { CERT_WINDOW_MS } from '@/lib/pitboss/certTiming'

const LOCKOUT_HOURS = 24
const REGEN_EVERY_N = 4

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

  // Exam room results sync uses the driver's Discord username, falling back
  // to display name or driver id if Discord username is somehow unset.
  const discordUsername =
    (driver as any).discord_username ?? (driver as any).display_name ?? driver.id

  let body: { certification_id: string; answers: Record<string, string> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { certification_id, answers } = body ?? ({} as typeof body)
  if (
    !certification_id ||
    typeof certification_id !== 'string' ||
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers)
  ) {
    return NextResponse.json(
      { error: 'certification_id and answers are required' },
      { status: 400 }
    )
  }
  if (Object.keys(answers).length > 200) {
    return NextResponse.json({ error: 'Too many answers' }, { status: 400 })
  }

  const { data: cert, error: certError } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, driver_id, league_id, role_code, status, started_at, pass_mark, attempt_number, question_ids')
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

  const now = new Date()
  const elapsed = now.getTime() - new Date(cert.started_at).getTime()

  if (elapsed > CERT_WINDOW_MS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_HOURS * 60 * 60 * 1000)

    // Claim atomically: only the request that still sees in_progress wins.
    const { data: expiredClaim, error: expiredErr } = await supabase
      .schema('pitboss')
      .from('certifications')
      .update({ status: 'failed', score: 0, completed_at: now.toISOString(), locked_until: lockedUntil.toISOString() })
      .eq('id', certification_id)
      .eq('status', 'in_progress')
      .select('id')

    if (expiredErr) {
      return NextResponse.json({ error: 'Failed to record result' }, { status: 500 })
    }
    if (!expiredClaim?.length) {
      return NextResponse.json({ error: 'Certification was already submitted' }, { status: 409 })
    }

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

    syncCertScoreToSheet({
      leagueId: cert.league_id,
      roleCode: cert.role_code,
      discordUsername,
      score: 0,
      passMark: Number(cert.pass_mark),
      passed: false,
      completedAt: now.toISOString(),
    }).catch((err) => console.error('[cert/submit] sheets sync failed', err))

    return NextResponse.json(
      { error: 'Time expired — certification failed', locked_until: lockedUntil.toISOString() },
      { status: 422 }
    )
  }

  // Grade against the question set the server drew for this attempt
  // (certifications.question_ids, written by cert/start), NOT the ids the
  // client sends. Grading only the submitted ids let a driver answer one
  // question correctly, skip the rest, and score 100%. Unanswered questions
  // now count as wrong, and ids outside the drawn set are ignored.
  const drawnIds: string[] = Array.isArray(cert.question_ids) ? cert.question_ids : []
  if (drawnIds.length === 0) {
    // Legacy attempt from before question_ids existed. cert/start tells the
    // driver to begin a new attempt in this case; there is no trusted set to
    // grade against, so don't fall back to the client's.
    return NextResponse.json(
      { error: 'This attempt predates grading support. Please start a new attempt.' },
      { status: 410 }
    )
  }

  const { data: questions, error: questionsError } = await supabase
    .schema('pitboss')
    .from('questions')
    .select('id, correct_answer')
    .in('id', drawnIds)

  if (questionsError || !questions) {
    console.error('[cert/submit] questions fetch', questionsError)
    return NextResponse.json({ error: 'Failed to fetch questions' }, { status: 500 })
  }

  const total = questions.length
  let correct = 0
  const breakdown: Record<string, { correct: boolean; correct_answer: string }> = {}

  for (const q of questions) {
    const submitted = typeof answers[q.id] === 'string' ? answers[q.id] : null
    const isCorrect = submitted !== null && submitted === q.correct_answer
    if (isCorrect) correct++
    breakdown[q.id] = { correct: isCorrect, correct_answer: q.correct_answer }
  }

  const score = total > 0 ? Math.round((correct / total) * 100 * 100) / 100 : 0
  const passed = score >= Number(cert.pass_mark)

  if (passed) {
    const token = crypto.randomUUID()

    // Claim atomically so a double-submit can't mint two tokens/licences.
    const { data: passClaim, error: passErr } = await supabase.schema('pitboss').from('certifications')
      .update({ status: 'passed', score, completed_at: now.toISOString(), token })
      .eq('id', certification_id)
      .eq('status', 'in_progress')
      .select('id')

    if (passErr) {
      return NextResponse.json({ error: 'Failed to record result' }, { status: 500 })
    }
    if (!passClaim?.length) {
      return NextResponse.json({ error: 'Certification was already submitted' }, { status: 409 })
    }

    await supabase.schema('pitboss').from('driver_leagues')
      .update({ certified: true, certified_at: now.toISOString() })
      .eq('driver_id', driver.id)
      .eq('league_id', cert.league_id)

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

    syncCertScoreToSheet({
      leagueId: cert.league_id,
      roleCode: cert.role_code,
      discordUsername,
      score,
      passMark: Number(cert.pass_mark),
      passed: true,
      completedAt: now.toISOString(),
    }).catch((err) => console.error('[cert/submit] sheets sync failed', err))

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
    let licenceId: string | null = existingLicence?.id ?? null

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
          driver_id: driver.id,
          league_id: cert.league_id,
          licence_number: newLicenceNumber,
          role_code: cert.role_code,
          title: `${league?.name ?? 'League'} ${roleReq?.role_name ?? cert.role_code}`,
          status: 'active',
        })
        .select('id, licence_number')
        .single()

      licenceNumber = newLicence?.licence_number ?? newLicenceNumber
      licenceId = newLicence?.id ?? null
    }

    return NextResponse.json({
      passed: true,
      score,
      pass_mark: cert.pass_mark,
      correct,
      total,
      token,
      licence_number: licenceNumber,
      licence_id: licenceId,
      breakdown,
    })
  } else {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_HOURS * 60 * 60 * 1000)

    const { data: failClaim, error: failErr } = await supabase.schema('pitboss').from('certifications')
      .update({ status: 'failed', score, completed_at: now.toISOString(), locked_until: lockedUntil.toISOString() })
      .eq('id', certification_id)
      .eq('status', 'in_progress')
      .select('id')

    if (failErr) {
      return NextResponse.json({ error: 'Failed to record result' }, { status: 500 })
    }
    if (!failClaim?.length) {
      return NextResponse.json({ error: 'Certification was already submitted' }, { status: 409 })
    }

    await maybeTriggerRegen(supabase, cert.league_id, cert.role_code)

    syncCertScoreToSheet({
      leagueId: cert.league_id,
      roleCode: cert.role_code,
      discordUsername,
      score,
      passMark: Number(cert.pass_mark),
      passed: false,
      completedAt: now.toISOString(),
    }).catch((err) => console.error('[cert/submit] sheets sync failed', err))

    return NextResponse.json({
      passed: false,
      score,
      pass_mark: cert.pass_mark,
      correct,
      total,
      missed_by: Math.round((Number(cert.pass_mark) - score) * 100) / 100,
      locked_until: lockedUntil.toISOString(),
      // Failed attempt: report only right/wrong per question. Sending
      // correct_answer here would let a driver read the answer key and pass
      // the retake once the lockout ends.
      breakdown: Object.fromEntries(
        Object.entries(breakdown).map(([id, b]) => [id, { correct: b.correct }])
      ),
    })
  }
}
