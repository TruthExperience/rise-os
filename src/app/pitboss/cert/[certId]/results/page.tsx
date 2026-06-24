'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'

interface BreakdownItem {
  question_id: string
  selected: string | null
  correct_answer: string
  correct: boolean
  explanation: string | null
}

interface CertResult {
  certification_id: string
  status: 'passed' | 'failed'
  passed: boolean
  score: number
  pass_mark: number
  correct_count: number
  total_questions: number
  locked_until?: string
  breakdown: BreakdownItem[]
}

export default function CertResultsPage() {
  const router            = useRouter()
  const { certId }        = useParams<{ certId: string }>()
  const [result, setResult] = useState<CertResult | null>(null)
  const [showBreakdown, setShowBreakdown] = useState(false)

  useEffect(() => {
    const raw = sessionStorage.getItem(`cert:${certId}:results`)
    if (raw) {
      try {
        setResult(JSON.parse(raw))
      } catch {
        router.replace('/pitboss/cert')
      }
    } else {
      router.replace('/pitboss/cert')
    }
  }, [certId, router])

  if (!result) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  const { passed, score, pass_mark, correct_count, total_questions, locked_until, breakdown } = result

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Result card */}
      <div
        className={`rounded-2xl border p-6 mb-6 text-center ${
          passed
            ? 'border-green-500/30 bg-green-500/10'
            : 'border-rise-red/30 bg-rise-red/10'
        }`}
      >
        <div className="text-5xl mb-3">{passed ? '✓' : '✗'}</div>
        <h1 className={`text-2xl font-black mb-1 ${passed ? 'text-green-400' : 'text-rise-red'}`}>
          {passed ? 'Certified' : 'Not Passed'}
        </h1>
        <p className="text-4xl font-black text-white mt-4">{score}%</p>
        <p className="text-xs text-white/30 mt-1">Pass mark: {pass_mark}%</p>
        <p className="text-sm text-white/50 mt-3">
          {correct_count} / {total_questions} correct
        </p>
      </div>

      {/* Lockout notice */}
      {!passed && locked_until && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 mb-6">
          <p className="text-xs font-bold text-yellow-400 uppercase tracking-wide">Locked Out</p>
          <p className="text-sm text-white/60 mt-1">
            You can retry after{' '}
            <span className="text-white font-semibold">
              {new Date(locked_until).toLocaleString()}
            </span>
          </p>
        </div>
      )}

      {/* Licence issued notice */}
      {passed && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3 mb-6">
          <p className="text-xs font-bold text-green-400 uppercase tracking-wide">Licence Issued</p>
          <p className="text-sm text-white/60 mt-1">
            Your driver licence has been issued and is active.
          </p>
        </div>
      )}

      {/* Breakdown toggle */}
      <button
        onClick={() => setShowBreakdown((v) => !v)}
        className="w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-white/60 mb-3"
      >
        {showBreakdown ? 'Hide' : 'Review'} Answers
      </button>

      {showBreakdown && (
        <div className="flex flex-col gap-3 mb-6">
          {breakdown.map((item, i) => (
            <div
              key={item.question_id}
              className={`rounded-xl border px-4 py-3 ${
                item.correct
                  ? 'border-green-500/20 bg-green-500/5'
                  : 'border-rise-red/20 bg-rise-red/5'
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-xs text-white/30">Q{i + 1}</p>
                <span
                  className={`text-xs font-bold ${
                    item.correct ? 'text-green-400' : 'text-rise-red'
                  }`}
                >
                  {item.correct ? '✓' : '✗'}
                </span>
              </div>

              {!item.correct && (
                <>
                  <p className="text-xs text-white/40 mb-1">Your answer:</p>
                  <p className="text-sm text-rise-red mb-2">
                    {item.selected ?? 'No answer'}
                  </p>
                  <p className="text-xs text-white/40 mb-1">Correct answer:</p>
                  <p className="text-sm text-green-400 mb-2">{item.correct_answer}</p>
                </>
              )}

              {item.explanation && (
                <p className="text-xs text-white/40 mt-2 leading-relaxed">
                  {item.explanation}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => router.push('/pitboss')}
          className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white"
        >
          Back to Pitboss
        </button>
        {!passed && !locked_until && (
          <button
            onClick={() => router.push('/pitboss/cert')}
            className="w-full rounded-xl border border-white/10 py-3 text-sm font-bold text-white/60"
          >
            Try Again
          </button>
        )}
      </div>
    </main>
  )
}
