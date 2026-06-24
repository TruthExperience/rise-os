'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

type CertStatus =
  | 'loading'
  | 'eligible'
  | 'in_progress'
  | 'timed_out'
  | 'passed'
  | 'failed'
  | 'error'

interface StatusPayload {
  status:           CertStatus
  certification_id?: string
  score?:           number
  pass_mark?:       number
  locked_until?:    string
  attempt_number?:  number
  licence?: {
    id:             string
    licence_number: string
    status:         string
    issued_at:      string
  } | null
}

const LEAGUE_META: Record<string, { name: string; pass_mark: number; color: string }> = {
  trl: { name: 'Truth Racing League',    pass_mark: 95, color: '#E8284A' },
  wsc: { name: 'World Series Championship', pass_mark: 90, color: '#E8284A' },
}

// ─── Countdown helper ─────────────────────────────────────────────────────────

function useCountdown(until: string | undefined) {
  const [remaining, setRemaining] = useState('')

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

export default function CertGatePage() {
  const params               = useParams<{ leagueSlug: string }>()
  const router               = useRouter()
  const leagueSlug           = params.leagueSlug
  const meta                 = LEAGUE_META[leagueSlug]

  const [payload, setPayload]   = useState<StatusPayload>({ status: 'loading' })
  const [leagueId, setLeagueId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const lockoutCountdown = useCountdown(
    payload.status === 'failed' ? payload.locked_until : undefined
  )

  // ── Resolve league_id then fetch status ──────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const leagueRes = await fetch(`/api/leagues?slug=${leagueSlug}`)
        const leagueJson = await leagueRes.json()
        const id: string = leagueJson.data?.[0]?.id
        if (!id) { setPayload({ status: 'error' }); return }
        setLeagueId(id)

        const res  = await fetch(`/api/pitboss/cert/status?league_id=${id}`)
        const json = await res.json()
        setPayload(json)
      } catch {
        setPayload({ status: 'error' })
      }
    }
    load()
  }, [leagueSlug])

  // ── Start cert ───────────────────────────────────────────────────────────────
  async function handleStart() {
    if (!leagueId) return
    setStarting(true)
    setError(null)
    try {
      const res  = await fetch('/api/pitboss/cert/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ league_id: leagueId }),
      })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Failed to start certification')
        setStarting(false)
        return
      }

      // Pass session data via sessionStorage so the test page doesn't need
      // to re-fetch — cert data is already loaded and questions are shuffled
      sessionStorage.setItem('cert_session', JSON.stringify(json))
      router.push(`/pitboss/cert/${leagueSlug}/test`)
    } catch {
      setError('Network error — please try again')
      setStarting(false)
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (payload.status === 'loading') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rise-red border-t-transparent" />
      </main>
    )
  }

  if (payload.status === 'error') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-6">
        <p className="text-sm text-white/40">League not found or unavailable.</p>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen flex-col bg-rise-black px-6 pt-12 pb-24">

      {/* Header */}
      <div className="mb-8 flex flex-col gap-1">
        <p className="text-[10px] font-medium tracking-widest uppercase text-rise-red">
          PitBoss Certification
        </p>
        <h1 className="text-2xl font-black tracking-tight text-white">
          {meta?.name ?? leagueSlug.toUpperCase()}
        </h1>
        <p className="text-sm text-white/40">
          Pass mark · <span className="text-white/70">{meta?.pass_mark ?? '—'}%</span>
        </p>
      </div>

      {/* Status card */}
      {payload.status === 'passed' && (
        <div className="mb-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400 mb-1">
            Certified
          </p>
          <p className="text-3xl font-black text-white mb-1">
            {payload.score?.toFixed(1)}%
          </p>
          <p className="text-sm text-white/50">
            Licence · <span className="text-white/80 font-mono">{payload.licence?.licence_number ?? '—'}</span>
          </p>
          <button
            onClick={() => router.push('/pitboss/licences')}
            className="mt-4 w-full rounded-xl bg-emerald-500/20 border border-emerald-500/30 py-3 text-sm font-semibold text-emerald-400 active:opacity-70"
          >
            View Licence
          </button>
        </div>
      )}

      {payload.status === 'failed' && (
        <div className="mb-6 rounded-2xl border border-rise-red/30 bg-rise-red/10 p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-rise-red mb-1">
            Failed · Attempt {payload.attempt_number}
          </p>
          <p className="text-3xl font-black text-white mb-1">
            {payload.score?.toFixed(1)}%
          </p>
          <p className="text-sm text-white/50">
            Required <span className="text-white/70">{payload.pass_mark}%</span> ·{' '}
            missed by{' '}
            <span className="text-rise-red font-semibold">
              {((payload.pass_mark ?? 0) - (payload.score ?? 0)).toFixed(1)}%
            </span>
          </p>
          {payload.locked_until && new Date(payload.locked_until) > new Date() && (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-xs text-white/40 uppercase tracking-widest">Unlocks in</span>
              <span className="font-mono text-sm text-white/70">{lockoutCountdown}</span>
            </div>
          )}
        </div>
      )}

      {payload.status === 'timed_out' && (
        <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400 mb-1">
            Timed Out
          </p>
          <p className="text-sm text-white/50">
            Your previous attempt expired. You may start a new attempt.
          </p>
        </div>
      )}

      {payload.status === 'in_progress' && (
        <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-400 mb-2">
            Attempt In Progress
          </p>
          <p className="text-sm text-white/50 mb-4">
            You have an active certification session. Resume it now.
          </p>
          <button
            onClick={() => router.push(`/pitboss/cert/${leagueSlug}/test`)}
            className="w-full rounded-xl bg-amber-500/20 border border-amber-500/30 py-3 text-sm font-semibold text-amber-400 active:opacity-70"
          >
            Resume Test
          </button>
        </div>
      )}

      {/* Rules summary */}
      <div className="mb-8 flex flex-col gap-3">
        {[
          ['Questions',    'All active questions for this league'],
          ['Time Limit',   '60 minutes — server enforced'],
          ['Pass Mark',    `${meta?.pass_mark ?? '—'}% or above`],
          ['On Fail',      '24-hour lockout before retry'],
          ['On Pass',      'Licence issued automatically'],
        ].map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs text-white/40 uppercase tracking-wide shrink-0">{label}</p>
            <p className="text-xs text-white/70 text-right">{value}</p>
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/30 bg-rise-red/10 px-4 py-3">
          <p className="text-xs text-rise-red">{error}</p>
        </div>
      )}

      {/* CTA */}
      {(payload.status === 'eligible' || payload.status === 'timed_out') && (
        <button
          onClick={handleStart}
          disabled={starting}
          className="w-full rounded-2xl bg-rise-red py-4 text-sm font-black tracking-wide text-white uppercase disabled:opacity-50 active:opacity-80"
        >
          {starting ? 'Starting…' : payload.attempt_number ? 'Retry Certification' : 'Begin Certification'}
        </button>
      )}

      {payload.status === 'failed' &&
        payload.locked_until &&
        new Date(payload.locked_until) <= new Date() && (
        <button
          onClick={handleStart}
          disabled={starting}
          className="w-full rounded-2xl bg-rise-red py-4 text-sm font-black tracking-wide text-white uppercase disabled:opacity-50 active:opacity-80"
        >
          {starting ? 'Starting…' : 'Retry Certification'}
        </button>
      )}
    </main>
  )
}
