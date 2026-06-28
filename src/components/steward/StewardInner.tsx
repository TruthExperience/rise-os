'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface Incident {
  id: string
  league_id: string
  incident_type: string
  description: string
  status: string
  verdict: string | null
  penalty: string | null
  penalty_points: number | null
  season: string | null
  round: number | null
  lap: number | null
  created_at: string
  resolved_at: string | null
  ai_verdict: string | null
  ai_confidence: number | null
}

interface League {
  id: string
  name: string
  slug: string
}

const STATUS_FILTERS = ['all', 'pending', 'resolved']

function statusColor(status: string) {
  if (status === 'resolved') return 'text-green-400 bg-green-500/20 border-green-500/30'
  if (status === 'pending')  return 'text-rise-red bg-rise-red/10 border-rise-red/30'
  return 'text-white/50 bg-white/10 border-white/10'
}

function verdictColor(v: string | null) {
  if (!v) return 'text-white/30'
  if (v === 'guilty')     return 'text-red-400'
  if (v === 'not_guilty') return 'text-green-400'
  return 'text-yellow-400'
}

export function StewardInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { status }   = useSession()

  const [leagues, setLeagues]           = useState<League[]>([])
  const [selectedLeague, setSelected]   = useState<League | null>(null)
  const [incidents, setIncidents]       = useState<Incident[]>([])
  const [filter, setFilter]             = useState('pending')
  const [loading, setLoading]           = useState(true)
  const [loadingInc, setLoadingInc]     = useState(false)
  const [error, setError]               = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Load leagues
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const all = (data.leagues ?? data) as League[]
        setLeagues(all)

        // Auto-select from query param
        const paramId = searchParams.get('league_id')
        if (paramId) {
          const match = all.find((l) => l.id === paramId)
          if (match) loadIncidents(match, filter)
        }
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  async function loadIncidents(league: League, statusFilter: string) {
    setSelected(league)
    setIncidents([])
    setError(null)
    setLoadingInc(true)
    try {
      const params = new URLSearchParams({ league_id: league.id })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const res  = await fetch(`/api/pitboss/incidents?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load incidents')
      setIncidents(data.incidents ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingInc(false)
    }
  }

  function handleFilterChange(f: string) {
    setFilter(f)
    if (selectedLeague) loadIncidents(selectedLeague, f)
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
        onClick={() => {
          if (selectedLeague) { setSelected(null); setIncidents([]) }
          else router.back()
        }}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">Steward Panel</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {selectedLeague ? selectedLeague.name : 'Select a league'}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {/* League selector */}
      {!selectedLeague && (
        <div className="flex flex-col gap-3">
          {leagues.map((league) => (
            <button
              key={league.id}
              onClick={() => loadIncidents(league, filter)}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <p className="text-sm font-bold text-white">{league.name}</p>
              <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">{league.slug}</p>
            </button>
          ))}
        </div>
      )}

      {/* Incident list */}
      {selectedLeague && (
        <>
          {/* Filter tabs */}
          <div className="flex gap-2 mb-5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => handleFilterChange(f)}
                className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase transition-colors ${
                  filter === f
                    ? 'bg-rise-red text-white'
                    : 'bg-white/5 text-white/40'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {loadingInc && (
            <div className="flex justify-center mt-12">
              <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
            </div>
          )}

          {!loadingInc && incidents.length === 0 && (
            <p className="text-white/30 text-sm text-center mt-12">
              No {filter === 'all' ? '' : filter} incidents.
            </p>
          )}

          {!loadingInc && incidents.map((inc) => (
            <button
              key={inc.id}
              onClick={() => router.push(`/pitboss/steward/${inc.id}?league_id=${selectedLeague.id}`)}
              className="w-full rounded-xl border border-white/10 bg-white/5 p-4 mb-3 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-white font-bold text-sm truncate">{inc.incident_type}</p>
                  <p className="text-white/40 text-xs mt-0.5 truncate">{inc.description}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {inc.season && (
                      <span className="text-[10px] text-white/20 uppercase">{inc.season}</span>
                    )}
                    {inc.round && (
                      <span className="text-[10px] text-white/20">Round {inc.round}</span>
                    )}
                    {inc.lap && (
                      <span className="text-[10px] text-white/20">Lap {inc.lap}</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-2">
                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${statusColor(inc.status)}`}>
                    {inc.status}
                  </span>
                  {inc.ai_verdict && (
                    <span className={`text-[10px] font-bold uppercase ${verdictColor(inc.ai_verdict)}`}>
                      AI: {inc.ai_verdict.replace('_', ' ')}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-white/20 text-[10px] mt-2">
                {new Date(inc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </button>
          ))}
        </>
      )}
    </main>
  )
}
