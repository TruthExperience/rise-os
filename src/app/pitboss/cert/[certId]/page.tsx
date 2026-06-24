'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'

interface Question {
  id: string
  category: string
  question: string
  options: string[]
  difficulty: string
}

interface CertSession {
  certification_id: string
  started_at: string
  pass_mark: number
  attempt_number: number
  total_questions: number
  league: { id: string; name: string; slug: string }
  questions: Question[]
}

const TIME_LIMIT_SECONDS = 45 * 60 // 45 minutes

export default function CertExamPage() {
  const router                        = useRouter()
  const { certId }                    = useParams<{ certId: string }>()
  const [session, setSession]         = useState<CertSession | null>(null)
  const [current, setCurrent]         = useState(0)
  const [answers, setAnswers]         = useState<Record<string, string>>({})
  const [secondsLeft, setSecondsLeft] = useState(TIME_LIMIT_SECONDS)
  const [submitting, setSubmitting]   = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(true)
  const timerRef                      = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load session from sessionStorage (set by /pitboss/cert on start)
  useEffect(() => {
    const raw = sessionStorage.getItem(`cert:${certId}`)
    if (raw) {
      try {
        const data: CertSession = JSON.parse(raw)
        setSession(data)

        // Calculate remaining time from server started_at
        const elapsed = Math.floor(
          (Date.now() - new Date(data.started_at).getTime()) / 1000
        )
        setSecondsLeft(Math.max(0, TIME_LIMIT_SECONDS - elapsed))
      } catch {
        setError('Session data corrupted — please restart the exam.')
      }
    } else {
      setError('No active session found — please restart the exam.')
    }
    setLoading(false)
  }, [certId])

  // Countdown timer
  useEffect(() => {
    if (!session || secondsLeft <= 0) return

    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!)
          handleSubmit(true) // auto-submit on timeout
          return 0
        }
        return s - 1
      })
    }, 1000)

    return () => clearInterval(timerRef.current!)
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(timeout = false) {
    if (!session || submitting) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/pitboss/cert/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certification_id: session.certification_id,
          answers,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Failed to submit — try again')
        setSubmitting(false)
        return
      }

      // Store results for the results page
      sessionStorage.setItem(`cert:${certId}:results`, JSON.stringify(data))
      sessionStorage.removeItem(`cert:${certId}`)

      router.replace(`/pitboss/cert/${certId}/results`)
    } catch {
      setError('Network error — check your connection and try again')
      setSubmitting(false)
    }
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  if (error || !session) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-4 gap-4">
        <p className="text-rise-red text-sm">{error ?? 'Something went wrong.'}</p>
        <button
          onClick={() => router.push('/pitboss/cert')}
          className="rounded-xl bg-rise-red px-6 py-3 text-sm font-bold text-white"
        >
          Back to Certification
        </button>
      </main>
    )
  }

  const questions  = session.questions
  const question   = questions[current]
  const isAnswered = !!answers[question.id]
  const isLast     = current === questions.length - 1
  const answeredCount = Object.keys(answers).length
  const timerWarning  = secondsLeft < 300 // last 5 minutes

  return (
    <main className="min-h-screen bg-rise-black flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-6 pb-3 border-b border-white/10">
        <div>
          <p className="text-xs text-white/30 uppercase tracking-widest">
            {session.league.name}
          </p>
          <p className="text-xs text-white/50 mt-0.5">
            {current + 1} / {questions.length}
          </p>
        </div>
        <div
          className={`text-sm font-black tabular-nums ${
            timerWarning ? 'text-rise-red animate-pulse' : 'text-white'
          }`}
        >
          {formatTime(secondsLeft)}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/10">
        <div
          className="h-1 bg-rise-red transition-all duration-300"
          style={{ width: `${((current + 1) / questions.length) * 100}%` }}
        />
      </div>

      {/* Question */}
      <div className="flex-1 px-4 pt-6 pb-4 overflow-y-auto">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-white/30">
            {question.category}
          </span>
          <span
            className={`text-[10px] uppercase tracking-widest font-bold ${
              question.difficulty === 'hard'
                ? 'text-rise-red'
                : question.difficulty === 'medium'
                ? 'text-yellow-400'
                : 'text-green-400'
            }`}
          >
            {question.difficulty}
          </span>
        </div>

        <p className="text-base font-bold text-white leading-snug mb-6">
          {question.question}
        </p>

        <div className="flex flex-col gap-3">
          {question.options.map((opt, i) => {
            const selected = answers[question.id] === opt
            return (
              <button
                key={i}
                onClick={() =>
                  setAnswers((prev) => ({ ...prev, [question.id]: opt }))
                }
                className={`w-full text-left rounded-xl border px-4 py-3 text-sm font-medium transition-all ${
                  selected
                    ? 'border-rise-red bg-rise-red/20 text-white'
                    : 'border-white/10 bg-white/5 text-white/70 hover:border-white/30 hover:text-white'
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="px-4 pb-8 pt-3 border-t border-white/10 flex items-center gap-3">
        <button
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
          className="rounded-xl border border-white/10 px-4 py-3 text-sm text-white/40 disabled:opacity-20"
        >
          ←
        </button>

        {!isLast ? (
          <button
            onClick={() => setCurrent((c) => c + 1)}
            disabled={!isAnswered}
            className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-bold text-white disabled:opacity-30"
          >
            Next
          </button>
        ) : (
          <button
            onClick={() => handleSubmit()}
            disabled={submitting || answeredCount < questions.length}
            className="flex-1 rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-30"
          >
            {submitting
              ? 'Submitting…'
              : answeredCount < questions.length
              ? `${questions.length - answeredCount} unanswered`
              : 'Submit Exam'}
          </button>
        )}

        {/* Jump to unanswered */}
        {answeredCount < questions.length && isLast && (
          <button
            onClick={() => {
              const first = questions.findIndex((q) => !answers[q.id])
              if (first !== -1) setCurrent(first)
            }}
            className="rounded-xl border border-white/10 px-4 py-3 text-sm text-white/40"
          >
            ?
          </button>
        )}
      </div>

      {error && (
        <div className="px-4 pb-4">
          <p className="text-xs text-rise-red text-center">{error}</p>
        </div>
      )}
    </main>
  )
}
