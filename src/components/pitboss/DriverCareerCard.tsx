// File: components/pitboss/DriverCareerCard.tsx
//
// Career tab on the driver profile page — wins/top3/top5/top10/fastest laps
// breakdown plus "Teams Driven For", sourced from GET
// /api/pitboss/drivers/[id]/career-stats.
//
// pitboss.results has 0 rows league-wide right now (race-result entry isn't
// built yet), so this renders an explicit empty state rather than a blank
// or misleading all-zero stat grid, and falls back to team history derived
// from driver_contracts so "Teams Driven For" isn't empty just because
// results are.

'use client'

import { useEffect, useState } from 'react'

interface Team {
  franchise_id: string
  name: string
  abbreviation: string | null
  logo_url: string | null
  primary_color: string | null
  source: 'results' | 'contract'
}

interface CareerStats {
  starts: number
  wins: number
  top3: number
  top5: number
  top10: number
  dnfs: number
  fastest_laps: number
}

interface CareerStatsResponse {
  stats: CareerStats
  teams: Team[]
  teams_source: 'results' | 'contract' | 'none'
  has_results: boolean
}

export default function DriverCareerCard({ driverId }: { driverId: string }) {
  const [data, setData] = useState<CareerStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const res = await fetch(`/api/pitboss/drivers/${driverId}/career-stats`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Failed to load career stats')
        if (!cancelled) setData(json)
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [driverId])

  if (loading) {
    return (
      <div className="bg-gray-900 rounded-xl p-4">
        <p className="text-gray-500 text-sm animate-pulse">Loading career history…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3">
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const { stats, teams, has_results } = data

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-white font-bold text-base uppercase tracking-widest">Career Results</h2>
        </div>

        {!has_results ? (
          <div className="bg-gray-900 rounded-xl p-4">
            <p className="text-gray-500 text-sm">
              No race results recorded yet. Career stats will appear here once results start being logged.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Starts', value: stats.starts, color: 'text-white' },
              { label: 'Wins', value: stats.wins, color: 'text-yellow-400' },
              { label: 'Top 3', value: stats.top3, color: 'text-orange-400' },
              { label: 'Top 5', value: stats.top5, color: 'text-orange-300' },
              { label: 'Top 10', value: stats.top10, color: 'text-white' },
              { label: 'Fastest Laps', value: stats.fastest_laps, color: 'text-purple-400' },
              { label: 'DNFs', value: stats.dnfs, color: 'text-red-400' },
            ].map((s) => (
              <div key={s.label} className="bg-gray-900 rounded-xl p-3 text-center">
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                <p className="text-gray-500 text-xs">{s.label}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-white font-bold text-base uppercase tracking-widest">Teams Driven For</h2>
          {teams.length > 0 && (
            <span className="bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded-full">{teams.length}</span>
          )}
        </div>

        {teams.length === 0 ? (
          <p className="text-gray-600 text-sm">No team history yet.</p>
        ) : (
          <div className="space-y-2">
            {teams.map((t) => (
              <div key={t.franchise_id} className="bg-gray-900 rounded-xl px-4 py-3 flex items-center gap-3">
                {t.logo_url && (
                  <img src={t.logo_url} alt={t.name} className="w-8 h-8 object-contain flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-white font-semibold text-sm truncate">{t.name}</p>
                  {t.source === 'contract' && (
                    <p className="text-gray-600 text-xs">From contract history · no race results yet</p>
                  )}
                </div>
                {t.abbreviation && (
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                    style={{
                      background: (t.primary_color ?? '#E8284A') + '33',
                      color: t.primary_color ?? '#E8284A',
                    }}
                  >
                    {t.abbreviation}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
