'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from '@/lib/compat/next-auth-react'

interface RosterDriver {
  id: string
  discord_username: string
  display_name: string | null
  team: string | null
  car_number: string | number | null
  role_primary: string | null
}

function DriversInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const leagueId = searchParams.get('league_id')
  const { status } = useSession()

  const [drivers, setDrivers] = useState<RosterDriver[]>([])
  const [search, setSearch]   = useState('')
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

    fetch(`/api/pitboss/leagues/${encodeURIComponent(leagueId)}/drivers`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(data.error ?? 'Failed to load drivers')
          return
        }
        setDrivers(data.drivers ?? [])
      })
      .catch(() => setError('Network error — try again'))
      .finally(() => setLoading(false))
  }, [status, leagueId])

  const q = search.trim().toLowerCase()
  const visible = q
    ? drivers.filter(
        (d) =>
          (d.display_name ?? d.discord_username).toLowerCase().includes(q) ||
          d.discord_username.toLowerCase().includes(q) ||
          (d.team ?? '').toLowerCase().includes(q)
      )
    : drivers

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

      <h1 className="text-xl font-black text-white">Drivers</h1>
      <p className="mt-1 mb-4 text-xs text-white/30">
        {drivers.length} drivers on this league&rsquo;s roster.
      </p>

      {error && <p className="text-sm text-rise-red">{error}</p>}

      {!error && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or team"
          className="mb-4 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
      )}

      {!error && visible.length === 0 && (
        <p className="text-sm text-white/40">No drivers found.</p>
      )}

      <div className="flex flex-col gap-2">
        {visible.map((d) => (
          <button
            key={d.id}
            onClick={() => router.push(`/pitboss/drivers/${d.id}`)}
            className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left"
          >
            <div>
              <p className="text-sm font-bold text-white">
                {d.display_name ?? d.discord_username}
              </p>
              <p className="text-[11px] text-white/30">
                {d.team ?? 'No team'}
                {d.role_primary ? ` · ${d.role_primary}` : ''}
              </p>
            </div>
            {d.car_number != null && (
              <span className="text-sm font-black tabular-nums text-white/60">
                #{d.car_number}
              </span>
            )}
          </button>
        ))}
      </div>
    </main>
  )
}

export default function DriversPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-rise-black">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </main>
      }
    >
      <DriversInner />
    </Suspense>
  )
}
