'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface League {
  id: string
  name: string
  slug: string
  pitboss_status: string
}

interface CertStatus {
  status: 'passed' | 'failed' | 'in_progress' | null
  locked_until: string | null
  certification_id: string | null
}

export default function CertPage() {
  const router = useRouter()
  const { status } = useSession()
  const [leagues, setLeagues]       = useState<League[]>([])
  const [statuses, setStatuses]     = useState<Record<string, CertStatus>>({})
  const [starting, setStarting]     = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return

    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const active = (data.leagues ?? data).filter(
          (l: League) => l.pitboss_status === 'active' || l.pitboss_status === 'trial'
        )
        setLeagues(active)
        return active
      })
      .then(async (active: League[]) => {
        const entries = await Promise.all(
          active.map(async (l: League) => {
            try {
              const r = await fetch(`/api/pitboss/cert/status?league_id=${l.id}`)
              const d = await r.json()
              if (!r.ok) return [l.id, { status: null, locked_until: null, certification_id: null }] as [string, CertStatus]
              return [l.id, d] as [string, CertStatus]
            } catch {
              return [l.id, { status: null, locked_until: null, certification_id: null }] as [string, CertStatus]
            }
          })
        )
        setStatuses(Object.fromEntries(entries))
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  async function handleStart(leagueId: string) {
    setStarting(leagueId)
    setError(null)
    try {
      const res = await fetch('/api/pitboss/cert/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId }),
      })
      const data = await res.json()

      if (!res.ok) {
        if (res.status === 409 && data.certification_id) {
          router.push(`/pitboss/cert/${data.certification_id}`)
          return
        }
        setError(data.error ?? 'Failed to start certification')
        return
      }

      sessionStorage.setItem(`cert:${data.certification_id}`, JSON.stringify(data))
      router.push(`/pitboss/cert/${data.certification_id}`)
    } catch {
      setError('Network error — try again')
    } finally {
      setStarting(null)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Certification</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          Select a league to begin
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {leagues.length === 0 && (
          <p className="text-white/30 text-sm text-center mt-12">
            No leagues available for certification.
          </p>
        )}

        {leagues.map((league) => {
          const cert        = statuses[league.id]
          const isPassed    = cert?.status === 'passed'
          const isLocked    = cert?.status === 'failed' && cert.locked_until
            ? new Date(cert.locked_until) > new Date()
            : false
          const isInProgress = cert?.status === 'in_progress'
          const isStarting   = starting === league.id

          return (
            <div
              key={league.id}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-white">{league.name}</p>
                  <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">
                    {league.slug}
                  </p>
                </div>

                {isPassed ? (
                  <span className="rounded-full bg-green-500/20 px-3 py-1 text-xs font-bold text-green-400">
                    Certified ✓
                  </span>
                ) : isLocked ? (
                  <div className="text-right">
                    <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-bold text-yellow-400">
                      Locked
                    </span>
                    <p className="text-[10px] text-white/30 mt-1">
                      Retry {new Date(cert!.locked_until!).toLocaleDateString()}
                    </p>
                  </div>
                ) : (
                  <button
                    onClick={() =>
                      isInProgress && cert?.certification_id
                        ? router.push(`/pitboss/cert/${cert.certification_id}`)
                        : handleStart(league.id)
                    }
                    disabled={isStarting}
                    className="rounded-xl bg-rise-red px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {isStarting ? '...' : isInProgress ? 'Resume' : 'Begin'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
