'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Question {
  id:         string
  category:   string
  question:   string
  options:    string[]
  difficulty: string
}

interface CertSession {
  certification_id: string
  started_at:       string
  pass_mark:        number
  attempt_number:   number
  total_questions:  number
  league:           { id: string; name: string; slug: string }
  questions:        Question[]
}

const CERT_WINDOW_MS = 60 * 60 * 1000 // 60 min — mirrors server

// ─── Timer hook ───────────────────────────────────────────────────────────────

function useTimer(startedAt: string | null, onExpire: () => void) {
  const [display, setDisplay]   = useState('60:00')
  const [expired, setExpired]   = useState(false)
  const expiredRef               = useRef(false)
  const onExpireRef              = useRef(onExpire)
  onExpireRef.current            = onExpire

  useEffect(() => {
    if (!startedAt) return
    const tick = () => {
      const elapsed  = Date.now() - new Date(startedAt).getTime()
      const remaining = CERT_WINDOW_MS - elapsed
      if (remaining <= 0 && !expiredRef.current) {
        expiredRef.current = true
        setExpired(true)
        setDisplay('00:00')
        onExpireRef.current()
        return
      }
      const m = Math.floor(Math.max(remaining, 0) / 60_000)
      const s = Math.floor((Math.max(remaining, 0) % 60_000) / 1_000)
      setDisplay(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [startedAt])

  return { display, expired }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CertTestPage() {
  const params     = useParams<{ leagueSlug: string }>()
  const router     = useRouter()
  const leagueSlug = params.leagueSlug

  const [session, setSession]       = useState<CertSession | null>(null)
  const [answers, setAnswers]       = useState<Record<string, string>>({})
  const [current, setCurrent]       = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmed, setConfirmed]   = useState(false) // final submit confirmation

  // ── Load session from sessionStorage ─────────────────────────────────────────
  useEffect(() => {
    const raw = sessionStorage.getItem('cert_session')
    if (!raw) {
      // No session — redirect back to gate
      router.replace(`/pitboss/cert/${leagueSlug}`)
      return
    }
    try {
      setSession(JSON.parse(raw))
    } catch {
      router.replace(`/pitboss/cert/${leagueSlug}`)
    }
  }, [leagueSlug, router])

  // ── Auto-submit on timer expiry ───────────────────────────────────────────────
  const { display: timerDisplay, expired: timerExpired } = useTimer(
    session?.started_at ?? null,
    () => { handleSubmit(true) }
  )

  // ── Answer selection ──────────────────────────────────────────────────────────
  function selectAnswer(questionId: string, option: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: option }))
  }

  // ── Navigation ────────────────────────────────────────────────────────────────
  function goTo(index: number) {
    if (!session) return
    setCurrent(Math.max(0, Math.min(index, session.questions.length - 1)))
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  async function handleSubmit(forced = false) {
    if (!session) return
    if (!forced && !confirmed) {
      setConfirmed(true)
      return
    }
    setSubmitting(true)
    setSubmitError(null)

    try {
      const res  = await fetch('/api/pitboss/cert/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          certification_id: session.certification_id,
          answers,
        }),
      })
      const json = await res.json()

      // Clear session storage
      sessionStorage.removeItem('cert_session')

      // Pass result to result page via sessionStorage
      sessionStorage.setItem('cert_result', JSON.stringify({
        ...json,
        league_slug: leagueSlug,
        league_name: session.league.name,
        total:       session.total_questions,
      }))

      router.replace(`/pitboss/cert/${leagueSlug}/result`)
    } catch {
      setSubmitError('Network error — your answers are saved locally, please retry.')
      setSubmitting(false)
      setConfirmed(false)
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rise-red border-t-transparent" />
      </main>
    )
  }

  const questions    = session.questions
  const q            = questions[current]
  const answered     = Object.keys(answers).length
  const totalQ       = questions.length
  const isLast       = current === totalQ - 1
  const unanswered   = totalQ - answered
  const timerWarning = timerDisplay <= '05:00' && !timerExpired
  const timerDanger  = timerDisplay <= '01:00' && !timerExpired

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col bg-rise-black pb-24">

      {/* ── Sticky header ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-[#111] border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="flex flex-col">
          <p className="text-[10px] uppercase tracking-widest text-white/30">
            {session.league.name}
          </p>
          <p className="text-xs text-white/60">
            Q{current + 1} of {totalQ}
            <span className="ml-2 text-white/30">· {answered} answered</span>
          </p>
        </div>
        {/* Timer */}
        <div
          className={`rounded-full px-3 py-1 font-mono text-sm font-bold tabular-nums ${
            timerDanger
              ? 'bg-rise-red/20 text-rise-red animate-pulse'
              : timerWarning
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-white/5 text-white/60'
          }`}
        >
          {timerDisplay}
        </div>
      </div>

      {/* ── Progress bar ──────────────────────────────────────────────────────── */}
      <div className="h-0.5 bg-white/5">
        <div
          className="h-full bg-rise-red transition-all duration-300"
          style={{ width: `${((current + 1) / totalQ) * 100}%` }}
        />
      </div>

      {/* ── Question ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 px-5 pt-6">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/30 uppercase tracking-wide">
            {q.category}
          </span>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/30 uppercase tracking-wide">
            {q.difficulty}
          </span>
        </div>

        <p className="mt-3 mb-6 text-base font-semibold leading-snug text-white">
          {q.question}
        </p>

        {/* Options */}
        <div className="flex flex-col gap-3">
          {q.options.map((opt) => {
            const selected = answers[q.id] === opt
            return (
              <button
                key={opt}
                onClick={() => selectAnswer(q.id, opt)}
                className={`w-full rounded-xl border px-4 py-3.5 text-left text-sm font-medium transition-colors active:opacity-70 ${
                  selected
                    ? 'border-rise-red bg-rise-red/10 text-white'
                    : 'border-white/10 bg-white/5 text-white/70 hover:border-white/20 hover:bg-white/8'
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>

        {/* ── Question grid nav ──────────────────────────────────────────────── */}
        <div className="mt-8 mb-2">
          <p className="text-[10px] text-white/30 uppercase tracking-widest mb-3">
            Jump to question
          </p>
          <div className="flex flex-wrap gap-2">
            {questions.map((qItem, i) => {
              const isAnswered = !!answers[qItem.id]
              const isCurrent  = i === current
              return (
                <button
                  key={qItem.id}
                  onClick={() => goTo(i)}
                  className={`h-8 w-8 rounded-lg text-xs font-bold transition-colors ${
                    isCurrent
                      ? 'bg-rise-red text-white'
                      : isAnswered
                      ? 'bg-white/10 text-white/60'
                      : 'bg-white/5 text-white/20'
                  }`}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Submit error ──────────────────────────────────────────────────────── */}
      {submitError && (
        <div className="mx-5 mt-4 rounded-xl border border-rise-red/30 bg-rise-red/10 px-4 py-3">
          <p className="text-xs text-rise-red">{submitError}</p>
        </div>
      )}

      {/* ── Confirm banner ────────────────────────────────────────────────────── */}
      {confirmed && !submitting && (
        <div className="mx-5 mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-400 mb-1">
            Submit {unanswered > 0 ? `with ${unanswered} unanswered?` : 'your answers?'}
          </p>
          <p className="text-xs text-white/40 mb-4">
            You cannot change answers after submission. This action is final.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmed(false)}
              className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2.5 text-sm text-white/60"
            >
              Cancel
            </button>
            <button
              onClick={() => handleSubmit(true)}
              className="flex-1 rounded-xl bg-rise-red py-2.5 text-sm font-bold text-white"
            >
              Submit Final
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom navigation ─────────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/10 bg-[#111] px-5 py-4 pb-safe flex gap-3">
        <button
          onClick={() => goTo(current - 1)}
          disabled={current === 0}
          className="flex-1 rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-semibold text-white/60 disabled:opacity-30"
        >
          ← Prev
        </button>

        {!isLast ? (
          <button
            onClick={() => goTo(current + 1)}
            className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-semibold text-white active:opacity-70"
          >
            Next →
          </button>
        ) : (
          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting || timerExpired || confirmed}
            className="flex-1 rounded-xl bg-rise-red py-3 text-sm font-black text-white uppercase tracking-wide disabled:opacity-50 active:opacity-70"
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        )}
      </div>
    </main>
  )
}
