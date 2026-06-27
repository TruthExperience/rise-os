'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

interface Question {
  id: string
  question: string
  options: string[]
  category: string
  difficulty: string
}

interface AnswerRecord {
  question_id: string
  selected_answer: string
  is_correct: boolean
}

interface ExamSession {
  id: string
  certification_id: string
  current_index: number
  question_ids: string[]
  answers: AnswerRecord[]
  questions: Question[]
  expires_at: string
}

interface ExamPageProps {
  params: { leagueSlug: string }
}

export default function ExamPage({ params }: ExamPageProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const certificationId = searchParams.get('cert_id')
  const driverId = searchParams.get('driver_id')
  const leagueId = searchParams.get('league_id')
  const roleCode = searchParams.get('role_code') ?? 'DRV'

  const [session, setSession] = useState<ExamSession | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showResumeBanner, setShowResumeBanner] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'done'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [result, setResult] = useState<{ score: number; passed: boolean; correct: number; total: number } | null>(null)

  useEffect(() => {
    if (!certificationId) {
      setErrorMsg('No certification ID provided.')
      setLoadState('error')
      return
    }
    loadSession()
  }, [certificationId])

  async function loadSession() {
    setLoadState('loading')
    try {
      const res = await fetch(`/api/exam-session?certification_id=${certificationId}`)
      const data = await res.json()

      if (data.session) {
        setSession(data.session)
        setCurrentIndex(data.session.current_index)
        setShowResumeBanner(data.session.current_index > 0)
        setLoadState('ready')
        return
      }

      const startRes = await fetch('/api/exam-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certification_id: certificationId,
          driver_id: driverId,
          league_id: leagueId,
          role_code: roleCode,
        }),
      })
      const startData = await startRes.json()

      if (!startRes.ok || startData.error) {
        throw new Error(startData.error ?? 'Failed to start exam')
      }

      setSession(startData.session)
      setCurrentIndex(0)
      setLoadState('ready')
    } catch (err: any) {
      setErrorMsg(err.message ?? 'Something went wrong. Please try again.')
      setLoadState('error')
    }
  }

  const saveProgress = useCallback(
    async (questionId: string, answer: string, isCorrect: boolean, nextIdx: number) => {
      if (!session) return
      try {
        await fetch('/api/exam-session/progress', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.id,
            question_id: questionId,
            selected_answer: answer,
            is_correct: isCorrect,
            next_index: nextIdx,
          }),
        })
      } catch {
        console.warn('Progress save failed; will retry on next answer')
      }
    },
    [session]
  )

  async function handleAnswer() {
    if (!selectedAnswer || !session || isSubmitting) return
    setIsSubmitting(true)

    const currentQ = session.questions[currentIndex]

    let isCorrect = false
    try {
      const checkRes = await fetch(
        `/api/exam-session/check-answer?question_id=${currentQ.id}&answer=${encodeURIComponent(selectedAnswer)}`
      )
      const checkData = await checkRes.json()
      isCorrect = checkData.is_correct ?? false
    } catch {
      // mark wrong and continue
    }

    const nextIdx = currentIndex + 1
    const isLastQuestion = nextIdx >= session.questions.length

    await saveProgress(currentQ.id, selectedAnswer, isCorrect, nextIdx)

    if (isLastQuestion) {
      const completeRes = await fetch('/api/exam-session/progress', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id }),
      })
      const completeData = await completeRes.json()
      setResult(completeData)
      setLoadState('done')
    } else {
      setCurrentIndex(nextIdx)
      setSelectedAnswer(null)
    }

    setIsSubmitting(false)
  }

  async function handleRestart() {
    setShowResumeBanner(false)
    setSession(null)
    setCurrentIndex(0)
    setSelectedAnswer(null)
    setResult(null)
    await loadSession()
  }

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white text-lg animate-pulse">Loading exam…</p>
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-[#E8284A] text-lg text-center">{errorMsg}</p>
        <button
          onClick={() => router.push(`/cert/${params.leagueSlug}`)}
          className="bg-[#E8284A] text-white font-bold py-3 px-8 rounded-full"
        >
          Back to Certification
        </button>
      </div>
    )
  }

  if (loadState === 'done' && result) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-3xl font-bold text-white">
          {result.passed ? '✅ Certified!' : '❌ Not Passed'}
        </h1>
        <p className="text-white text-xl">
          Score: <span className="text-[#E8284A] font-bold">{result.score}%</span>
        </p>
        <p className="text-gray-400">
          {result.correct} / {result.total} correct
        </p>
        {!result.passed && (
          <p className="text-gray-400 text-sm">You can retry in 24 hours.</p>
        )}
        <button
          onClick={() => router.push(`/cert/${params.leagueSlug}`)}
          className="bg-[#E8284A] text-white font-bold py-3 px-8 rounded-full mt-4"
        >
          Back to Certification
        </button>
      </div>
    )
  }

  if (!session) return null

  const currentQ = session.questions[currentIndex]
  const totalQ = session.questions.length
  const progress = Math.round((currentIndex / totalQ) * 100)

  return (
    <div className="min-h-screen bg-[#1A1A1A] flex flex-col">
      {showResumeBanner && (
        <div className="bg-[#E8284A]/20 border-b border-[#E8284A]/40 px-4 py-3 flex items-center justify-between">
          <p className="text-white text-sm">
            ▶ Resuming from question {currentIndex + 1} of {totalQ}
          </p>
          <button
            onClick={handleRestart}
            className="text-[#E8284A] text-sm font-semibold underline"
          >
            Start over
          </button>
        </div>
      )}

      <div className="w-full h-1 bg-gray-800">
        <div
          className="h-1 bg-[#E8284A] transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <span className="text-gray-400 text-sm">{currentQ.category}</span>
        <span className="text-gray-400 text-sm font-mono">
          {currentIndex + 1} / {totalQ}
        </span>
      </div>

      <div className="flex-1 px-4 py-6 flex flex-col gap-6">
        <h2 className="text-white text-xl font-semibold leading-snug">
          {currentQ.question}
        </h2>

        <div className="flex flex-col gap-3">
          {currentQ.options.map((option: string) => (
            <button
              key={option}
              onClick={() => setSelectedAnswer(option)}
              className={`w-full text-left px-4 py-4 rounded-xl border text-white transition-all ${
                selectedAnswer === option
                  ? 'border-[#E8284A] bg-[#E8284A]/15'
                  : 'border-gray-700 bg-gray-900 hover:border-gray-500'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-8">
        <button
          onClick={handleAnswer}
          disabled={!selectedAnswer || isSubmitting}
          className="w-full bg-[#E8284A] disabled:opacity-40 text-white font-bold py-4 rounded-full text-lg transition-opacity"
        >
          {isSubmitting
            ? 'Saving…'
            : currentIndex + 1 === totalQ
            ? 'Submit Exam'
            : 'Next Question'}
        </button>
      </div>
    </div>
  )
}
