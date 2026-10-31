'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from '@/lib/compat/next-auth-react'

interface CertRow {
  id: string
  driver_id: string
  driver_name: string
  role_code: string
  status: string
  score: number | null
  pass_mark: number | null
  attempt_number: number | null
  started_at: string | null
  completed_at: string | null
  locked_until: string | null
  created_at: string
}

const STATUS_STYLES: Record<string, string> = {
  passed:      'text-green-400',
  failed:      'text-rise-red',
  in_progress: 'text-yellow-400',
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function CertAdminInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const leagueId = searchParams.get('league_id')
  const { status } = useSession()

  const [rows, setRows]       = useState<CertRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    if (!leagueId) {
      setError('No league selected — go back and pick a league first.')
      setLoading(false)
      return
    }

    fetch(`/api/pitboss/admin/certifications?league_id=${encodeURIComponent(leagueId)}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(data.error ?? 'Failed to load certifications')
          return
        }
        setRows(data.certifications ?? [])
      })
      .catch(() => setError('Network error — try again'))
      .finally(() => setLoading(false))
  }, [status, leagueId])

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 pt-6 pb-24">
      <button
        onClick={() => router.push('/pitboss/admin')}
        className="mb-4 text-xs text-white/40"
      >
        ← PitBoss Admin
      </button>

      <h1 className="text-xl font-black text-white">Certifications</h1>
      <p className="mt-1 mb-5 text-xs text-white/30">
        Most recent 200 exam attempts for this league.
      </p>

      {error && <p className="text-sm text-rise-red">{error}</p>}

      {!error && rows.length === 0 && (
        <p className="text-sm text-white/40">No certification attempts yet.</p>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <div
            key={r.id}
            className="rounded-2xl border border-white/10 bg-white/5 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-white">{r.driver_name}</p>
                <p className="text-[11px] uppercase tracking-widest text-white/30">
                  {r.role_code} · attempt {r.attempt_number ?? 1}
                </p>
              </div>
              <span
                className={`text-[11px] font-black uppercase tracking-widest ${
                  STATUS_STYLES[r.status] ?? 'text-white/50'
                }`}
              >
                {r.status.replace('_', ' ')}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/50">
              <span>
                Score: {r.score ?? '—'}
                {r.pass_mark != null ? ` / pass ${r.pass_mark}` : ''}
              </span>
              <span>Started: {formatDate(r.started_at)}</span>
              <span>Finished: {formatDate(r.completed_at)}</span>
              {r.locked_until && <span>Locked until: {formatDate(r.locked_until)}</span>}
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}

export default function CertAdminPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-rise-black">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </main>
      }
    >
      <CertAdminInner />
    </Suspense>
  )
}
