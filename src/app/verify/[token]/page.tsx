'use client'

import { useEffect, useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Question = {
  id: string
  category: string
  question: string
  options: Record<string, string>
  difficulty: 'easy' | 'medium' | 'hard'
}

type CertMeta = {
  cert_id: string
  attempt_number: number
  pass_mark: number
  driver: { display_name: string | null; discord_username: string }
  league: { name: string; slug: string }
  questions: Question[]
}

type BreakdownItem = {
  question_id: string
  correct: boolean
  correct_answer: string
  explanation: string | null
}

type SubmitResult = {
  passed: boolean
  score: number
  pass_mark: number
  correct: number
  total: number
  breakdown: BreakdownItem[]
  locked_until?: string
  next_attempt?: number
}

type Phase =
  | 'loading'
  | 'error'
  | 'already_passed'
  | 'already_failed'
  | 'locked'
  | 'quiz'
  | 'submitted'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCountdown(ms: number) {
  if (ms <= 0) return '00:00:00'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

const DIFFICULTY: Record<string, { label: string; cls: string }> = {
  easy:   { label: 'Easy',   cls: 'text-[#30D158] border-[#30D158]/30 bg-[#30D158]/10' },
  medium: { label: 'Medium', cls: 'text-[#FF9F0A] border-[#FF9F0A]/30 bg-[#FF9F0A]/10' },
  hard:   { label: 'Hard',   cls: 'text-[#FF3B30] border-[#FF3B30]/30 bg-[#FF3B30]/10' },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0A0A0F] text-[#F0F0F0] flex flex-col items-center justify-center px-4 py-12">
      {children}
    </div>
  )
}

function SectorBar({ total, current, answered }: { total: number; current: number; answered: number }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1 rounded-full transition-all duration-300 ${
            i < answered ? 'bg-[#E8E020]' : i === current ? 'bg-[#E8E020]/40' : 'bg-[#2A2A35]'
          }`}
          style={{ width: `${Math.max(8, Math.floor(100 / total) - 0.5)}%` }}
        />
      ))}
    </div>
  )
}

function Spinner() {
  return (
    <Shell>
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-[#E8E020]/20 border-t-[#E8E020] animate-spin" />
        <p className="font-mono text-xs text-[#6B6B7A] tracking-[0.2em] uppercase">
          Retrieving certification
        </p>
      </div>
    </Shell>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <Shell>
      <div className="max-w-sm w-full text-center space-y-4">
        <p className="text-4xl">🚩</p>
        <h1 className="text-lg font-semibold text-[#FF3B30]">Certification Unavailable</h1>
        <p className="text-sm text-[#6B6B7A] leading-relaxed">{message}</p>
      </div>
    </Shell>
  )
}

function AlreadyPassed({ score }: { score: number | null }) {
  return (
    <Shell>
      <div className="max-w-sm w-full text-center space-y-6">
        <p className="text-5xl">🏁</p>
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-[#6B6B7A] uppercase mb-1">Certification</p>
          <h1 className="text-2xl font-semibold text-[#30D158]">Already Passed</h1>
        </div>
        {score !== null && (
          <div className="inline-block bg-[#30D158]/10 border border-[#30D158]/20 rounded-xl px-10 py-5">
            <p className="font-mono text-4xl font-bold text-[#30D158]">{score.toFixed(1)}%</p>
            <p className="text-xs text-[#6B6B7A] mt-1 font-mono">Final score</p>
          </div>
        )}
        <p className="text-sm text-[#6B6B7A] leading-relaxed">
          Your licence has been issued. Contact your steward if you need assistance.
        </p>
      </div>
    </Shell>
  )
}

function LockedScreen({ countdown, attemptNumber }: { countdown: number; attemptNumber: number }) {
  return (
    <Shell>
      <div className="max-w-sm w-full text-center space-y-6">
        <div className="w-20 h-20 rounded-full bg-[#FF3B30]/10 border border-[#FF3B30]/20 flex items-center justify-center mx-auto">
          <span className="text-3xl">🔴</span>
        </div>
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-[#FF3B30] uppercase mb-1">Red Flag</p>
          <h1 className="text-2xl font-semibold">Certification Locked</h1>
        </div>
        <div className="bg-[#13131A] border border-[#2A2A35] rounded-xl p-6 space-y-2">
          <p className="font-mono text-xs text-[#6B6B7A] uppercase tracking-wider">Cooldown remaining</p>
          <p className="font-mono text-4xl font-bold text-[#E8E020] tabular-nums tracking-widest">
            {formatCountdown(countdown)}
          </p>
        </div>
        <p className="text-sm text-[#6B6B7A] leading-relaxed">
          Attempt {attemptNumber} failed. Your next attempt unlocks automatically when the timer reaches zero.
        </p>
      </div>
    </Shell>
  )
}

function QuizScreen({
  meta, current, answers, selected, submitting, onSelect, onNext,
}: {
  meta: CertMeta
  current: number
  answers: Record<string, string>
  selected: string | null
  submitting: boolean
  onSelect: (key: string) => void
  onNext: () => void
}) {
  const q = meta.questions[current]
  const optionKeys = Object.keys(q.options).sort()
  const isLast = current === meta.questions.length - 1
  const answeredCount = Object.keys(answers).length
  const diff = DIFFICULTY[q.difficulty] ?? DIFFICULTY.medium

  return (
    <Shell>
      <div className="max-w-2xl w-full space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] text-[#6B6B7A] uppercase">
              {meta.league.name}
            </p>
            <p className="text-sm font-medium text-[#F0F0F0] mt-0.5">
              {meta.driver.display_name ?? meta.driver.discord_username}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-mono text-[10px] text-[#6B6B7A] uppercase tracking-wider">
              Attempt {meta.attempt_number}
            </p>
            <p className="font-mono text-[10px] text-[#E8E020] uppercase tracking-wider">
              Pass mark {meta.pass_mark}%
            </p>
          </div>
        </div>

        {/* Progress */}
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="font-mono text-[10px] text-[#6B6B7A] uppercase tracking-wider">
              Q{current + 1} / {meta.questions.length}
            </span>
            <span className="font-mono text-[10px] text-[#6B6B7A] uppercase tracking-wider">
              {answeredCount} answered
            </span>
          </div>
          <SectorBar total={meta.questions.length} current={current} answered={answeredCount} />
        </div>

        {/* Question card */}
        <div className="bg-[#13131A] border border-[#2A2A35] rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[10px] px-2 py-0.5 rounded border border-[#2A2A35] text-[#6B6B7A] uppercase tracking-wider">
              {q.category}
            </span>
            <span className={`font-mono text-[10px] px-2 py-0.5 rounded border uppercase tracking-wider ${diff.cls}`}>
              {diff.label}
            </span>
          </div>

          <p className="text-[#F0F0F0] text-[15px] leading-relaxed font-medium">{q.question}</p>

          <div className="space-y-2">
            {optionKeys.map((key) => {
              const active = selected === key
              return (
                <button
                  key={key}
                  onClick={() => onSelect(key)}
                  className={`w-full text-left flex items-start gap-3 px-4 py-3.5 rounded-xl border transition-all duration-100 ${
                    active
                      ? 'border-[#E8E020] bg-[#E8E020]/10 text-[#F0F0F0]'
                      : 'border-[#2A2A35] bg-[#1A1A24] text-[#9090A0] hover:border-[#3A3A48] hover:text-[#F0F0F0]'
                  }`}
                >
                  <span
                    className={`font-mono text-[10px] mt-0.5 w-5 h-5 rounded flex items-center justify-center shrink-0 border transition-colors ${
                      active
                        ? 'border-[#E8E020] text-[#E8E020] bg-[#E8E020]/10'
                        : 'border-[#3A3A48] text-[#6B6B7A]'
                    }`}
                  >
                    {key}
                  </span>
                  <span className="text-sm leading-relaxed">{q.options[key]}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] text-[#6B6B7A] uppercase tracking-wider">
            {meta.questions.length - answeredCount - (selected ? 1 : 0)} remaining
          </p>
          <button
            onClick={onNext}
            disabled={!selected || submitting}
            className="px-6 py-2.5 bg-[#E8E020] text-[#0A0A0F] font-bold text-sm rounded-xl
                       disabled:opacity-25 disabled:cursor-not-allowed
                       hover:bg-[#F5F030] active:scale-95
                       transition-all duration-100 font-mono tracking-wide"
          >
            {submitting ? 'Submitting…' : isLast ? 'Submit Exam →' : 'Next →'}
          </button>
        </div>
      </div>
    </Shell>
  )
}

function ResultsScreen({
  result, meta, answers,
}: {
  result: SubmitResult
  meta: CertMeta
  answers: Record<string, string>
}) {
  const passed = result.passed

  return (
    <Shell>
      <div className="max-w-2xl w-full space-y-8 py-4">
        {/* Score hero */}
        <div className="text-center space-y-4">
          <p className="text-5xl">{passed ? '🏁' : '🔴'}</p>
          <p className={`font-mono text-[10px] tracking-[0.25em] uppercase ${passed ? 'text-[#30D158]' : 'text-[#FF3B30]'}`}>
            {passed ? 'Certification Passed' : 'Certification Failed'}
          </p>
          <div className={`inline-block rounded-2xl px-10 py-6 border ${
            passed ? 'bg-[#30D158]/10 border-[#30D158]/20' : 'bg-[#FF3B30]/10 border-[#FF3B30]/20'
          }`}>
            <p className={`font-mono text-5xl font-bold tabular-nums ${passed ? 'text-[#30D158]' : 'text-[#FF3B30]'}`}>
              {result.score.toFixed(1)}%
            </p>
            <p className="font-mono text-xs text-[#6B6B7A] mt-1.5">
              {result.correct} / {result.total} correct · Pass mark {result.pass_mark}%
            </p>
          </div>
          {passed && (
            <p className="text-sm text-[#6B6B7A]">Your licence will be issued by your commissioner shortly.</p>
          )}
          {!passed && result.locked_until && (
            <p className="text-sm text-[#6B6B7A]">
              Cooldown applied · Attempt {result.next_attempt} available after lockout expires.
            </p>
          )}
        </div>

        {/* Review */}
        <div className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.2em] text-[#6B6B7A] uppercase">Review</p>
          {meta.questions.map((q) => {
            const item = result.breakdown.find((b) => b.question_id === q.id)
            const yourKey = answers[q.id]
            const correct = item?.correct ?? false

            return (
              <div
                key={q.id}
                className={`bg-[#13131A] border rounded-xl p-4 space-y-2 ${
                  correct ? 'border-[#30D158]/20' : 'border-[#FF3B30]/20'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className={`font-mono text-sm mt-0.5 shrink-0 font-bold ${correct ? 'text-[#30D158]' : 'text-[#FF3B30]'}`}>
                    {correct ? '✓' : '✗'}
                  </span>
                  <div className="space-y-2 flex-1 min-w-0">
                    <p className="text-sm text-[#F0F0F0] leading-relaxed">{q.question}</p>
                    <div className="space-y-0.5">
                      <p className="font-mono text-[10px] text-[#6B6B7A]">
                        Your answer:{' '}
                        <span className={correct ? 'text-[#30D158]' : 'text-[#FF3B30]'}>
                          {yourKey} — {q.options[yourKey]}
                        </span>
                      </p>
                      {!correct && item && (
                        <p className="font-mono text-[10px] text-[#6B6B7A]">
                          Correct:{' '}
                          <span className="text-[#30D158]">
                            {item.correct_answer} — {q.options[item.correct_answer]}
                          </span>
                        </p>
                      )}
                    </div>
                    {item?.explanation && (
                      <p className="text-xs text-[#6B6B7A] leading-relaxed pt-2 border-t border-[#2A2A35]">
                        {item.explanation}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Shell>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VerifyPage({ params }: { params: { token: string } }) {
  const { token } = params

  const [phase, setPhase]             = useState<Phase>('loading')
  const [error, setError]             = useState<string | null>(null)
  const [meta, setMeta]               = useState<CertMeta | null>(null)
  const [current, setCurrent]         = useState(0)
  const [answers, setAnswers]         = useState<Record<string, string>>({})
  const [selected, setSelected]       = useState<string | null>(null)
  const [result, setResult]           = useState<SubmitResult | null>(null)
  const [lockedUntil, setLockedUntil] = useState<Date | null>(null)
  const [countdown, setCountdown]     = useState(0)
  const [submitting, setSubmitting]   = useState(false)
  const [priorScore, setPriorScore]   = useState<number | null>(null)
  const [attemptNumber, setAttemptNumber] = useState(1)

  // Countdown ticker
  useEffect(() => {
    if (!lockedUntil) return
    const tick = () => setCountdown(Math.max(0, lockedUntil.getTime() - Date.now()))
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [lockedUntil])

  // Bootstrap
  useEffect(() => {
    fetch(`/api/pitboss/verify/${token}`)
      .then(async (res) => {
        const data = await res.json()

        if (res.status === 404) { setError(data.error ?? 'Invalid or expired token.'); setPhase('error'); return }
        if (res.status === 423) { setLockedUntil(new Date(data.locked_until)); setAttemptNumber(data.attempt_number); setPhase('locked'); return }
        if (!res.ok)            { setError(data.error ?? 'Something went wrong.'); setPhase('error'); return }
        if (data.status === 'passed') { setPriorScore(data.score ?? null); setPhase('already_passed'); return }
        if (data.status === 'failed') { setPriorScore(data.score ?? null); setPhase('already_failed'); return }
        if (!data.questions?.length)  { setError('No questions configured. Contact your commissioner.'); setPhase('error'); return }

        setMeta({
          cert_id:        data.cert_id,
          attempt_number: data.attempt_number,
          pass_mark:      data.pass_mark,
          driver:         data.driver,
          league:         data.league,
          questions:      data.questions,
        })
        setPhase('quiz')
      })
      .catch(() => { setError('Failed to connect. Try again.'); setPhase('error') })
  }, [token])

  // Submit
  const handleSubmit = useCallback(async (finalAnswers: Record<string, string>) => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/pitboss/verify/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: finalAnswers }),
      })
      const data: SubmitResult = await res.json()
      setResult(data)
      setPhase('submitted')
      if (!data.passed && data.locked_until) setLockedUntil(new Date(data.locked_until))
    } catch {
      setError('Submission failed. Refresh and try again.')
      setPhase('error')
    } finally {
      setSubmitting(false)
    }
  }, [token])

  // Advance
  const handleNext = useCallback(() => {
    if (!selected || !meta) return
    const q = meta.questions[current]
    const next = { ...answers, [q.id]: selected }
    setAnswers(next)
    setSelected(null)
    if (current + 1 < meta.questions.length) { setCurrent((c) => c + 1) } else { handleSubmit(next) }
  }, [selected, meta, current, answers, handleSubmit])

  if (phase === 'loading')       return <Spinner />
  if (phase === 'error')         return <ErrorScreen message={error ?? 'An unexpected error occurred.'} />
  if (phase === 'already_passed') return <AlreadyPassed score={priorScore} />
  if (phase === 'already_failed') return <AlreadyPassed score={null} />
  if (phase === 'locked')        return <LockedScreen countdown={countdown} attemptNumber={attemptNumber} />
  if (phase === 'quiz' && meta)  return <QuizScreen meta={meta} current={current} answers={answers} selected={selected} submitting={submitting} onSelect={setSelected} onNext={handleNext} />
  if (phase === 'submitted' && result && meta) return <ResultsScreen result={result} meta={meta} answers={answers} />

  return null
}
