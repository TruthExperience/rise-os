'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CertResult {
  passed:          boolean
  score:           number
  pass_mark:       number
  correct:         number
  total:           number
  missed_by?:      number
  locked_until?:   string
  licence_number?: string | null
  licence_id?:     string | null
  league_slug:     string
  league_name:     string
}

// ─── Lockout countdown ────────────────────────────────────────────────────────

function useCountdown(until: string | undefined) {
  const [remaining, setRemaining] = useState('—')

  useEffect(() => {
    if (!until) return
    const tick = () => {
      const diff = new Date(until).getTime() - Date.now()
      if (diff <= 0) { setRemaining('00:00:00'); return }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
      setRemaining(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      )
    }
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [until])

  return remaining
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CertResultPage() {
  const params     = useParams<{ leagueSlug: string }>()
  const router     = useRouter()
  const leagueSlug = params.leagueSlug

  const [result, setResult] = useState<CertResult | null>(null)
  const lockoutCountdown    = useCountdown(result?.locked_until)

  useEffect(() => {
    const raw = sessionStorage.getItem('cert_result')
    if (!raw) {
      router.replace(`/pitboss/cert/${leagueSlug}`)
      return
    }
    try {
      const parsed = JSON.parse(raw)
      setResult(parsed)
      // Clear so a hard-refresh sends them back to the gate
      sessionStorage.removeItem('cert_result')
    } catch {
      router.replace(`/pitboss/cert/${leagueSlug}`)
    }
  }, [leagueSlug, router])

  if (!result) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rise-red border-t-transparent" />
      </main>
    )
  }

  const pct = result.score.toFixed(1)

  // ─── PASS ─────────────────────────────────────────────────────────────────────
  if (result.passed) {
    return (
      <main className="flex min-h-screen flex-col bg-rise-black px-6 pt-16 pb-24">

        {/* Icon */}
        <div className="mb-6 flex h-20 w-20 items-center justify-center self-center rounded-2xl bg-emerald-500/20">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className="h-10 w-10 text-emerald-400">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <p className="mb-1 text-center text-[10px] font-semibold uppercase tracking-widest text-emerald-400">
          Certification Passed
        </p>
        <h1 className="mb-2 text-center text-4xl font-black text-white">
          {pct}%
        </h1>
        <p className="mb-10 text-center text-sm text-white/40">
          {result.correct} of {result.total} correct · Pass mark {result.pass_mark}%
        </p>

        {/* Licence card */}
        {result.licence_number && (
          <div className="mb-8 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
            <p className="text-xs text-emerald-400/70 uppercase tracking-widest mb-1">
              Licence Issued
            </p>
            <p className="text-2xl font-black font-mono text-white">
              {result.licence_number}
            </p>
            <p className="mt-1 text-xs text-white/40">{result.league_name} · Driver</p>
          </div>
        )}

        {/* Stats */}
        <div className="mb-8 flex flex-col gap-2">
          {[
            ['Score',      `${pct}%`],
            ['Pass Mark',  `${result.pass_mark}%`],
            ['Correct',    `${result.correct} / ${result.total}`],
            ['League',     result.league_name],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="text-xs text-white/40 uppercase tracking-wide">{label}</p>
              <p className="text-sm font-semibold text-white/80">{value}</p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          {result.licence_id && (
            <button
              onClick={() => router.push(`/pitboss/licences/${result.licence_id}`)}
              className="w-full rounded-2xl bg-rise-red py-4 text-sm font-black uppercase tracking-wide text-white active:opacity-80"
            >
              View Licence Card
            </button>
          )}
          <button
            onClick={() => router.push('/pitboss/licences')}
            className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 text-sm font-semibold text-white/60 active:opacity-70"
          >
            My Licences
          </button>
          <button
            onClick={() => router.push('/pitboss')}
            className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 text-sm font-semibold text-white/60 active:opacity-70"
          >
            PitBoss Home
          </button>
        </div>
      </main>
    )
  }

  // ─── FAIL ─────────────────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col bg-rise-black px-6 pt-16 pb-24">

      {/* Icon */}
      <div className="mb-6 flex h-20 w-20 items-center justify-center self-center rounded-2xl bg-rise-red/20">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className="h-10 w-10 text-rise-red">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>

      <p className="mb-1 text-center text-[10px] font-semibold uppercase tracking-widest text-rise-red">
        Certification Failed
      </p>
      <h1 className="mb-2 text-center text-4xl font-black text-white">
        {pct}%
      </h1>
      <p className="mb-10 text-center text-sm text-white/40">
        {result.correct} of {result.total} correct · needed {result.pass_mark}%
      </p>

      {/* Miss detail */}
      <div className="mb-6 rounded-2xl border border-rise-red/30 bg-rise-red/10 p-5">
        <p className="text-xs text-rise-red/70 uppercase tracking-widest mb-1">Missed By</p>
        <p className="text-3xl font-black text-rise-red">
          {result.missed_by?.toFixed(1) ?? ((result.pass_mark - result.score).toFixed(1))}%
        </p>
      </div>

      {/* Lockout */}
      {result.locked_until && (
        <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-5">
          <p className="text-xs text-white/30 uppercase tracking-widest mb-1">Retry Unlocks In</p>
          <p className="text-2xl font-black font-mono text-white">{lockoutCountdown}</p>
          <p className="mt-1 text-xs text-white/30">
            {new Date(result.locked_until).toLocaleString()}
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="mb-8 flex flex-col gap-2">
        {[
          ['Score',     `${pct}%`],
          ['Pass Mark', `${result.pass_mark}%`],
          ['Correct',   `${result.correct} / ${result.total}`],
          ['League',    result.league_name],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs text-white/40 uppercase tracking-wide">{label}</p>
            <p className="text-sm font-semibold text-white/80">{value}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3">
        <button
          onClick={() => router.push(`/pitboss/cert/${leagueSlug}`)}
          className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 text-sm font-semibold text-white/60 active:opacity-70"
        >
          Back to Certification
        </button>
        <button
          onClick={() => router.push('/pitboss')}
          className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 text-sm font-semibold text-white/60 active:opacity-70"
        >
          PitBoss Home
        </button>
      </div>
    </main>
  )
}
