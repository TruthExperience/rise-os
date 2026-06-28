'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'

interface Penalty {
  id: string
  points: number
  reason: string
  source: string
  issued_at: string
  expires_at: string | null
  removed_at: string | null
  is_active: boolean
  league_id: string
}

interface Driver {
  id: string
  pp_total: number
  discord_username: string
  display_name: string | null
}

const PP_WARNING = 6
const PP_DANGER = 10
const PP_MAX = 12

function ppBarColor(total: number) {
  if (total >= PP_DANGER) return 'bg-red-500'
  if (total >= PP_WARNING) return 'bg-yellow-400'
  return 'bg-green-400'
}

function ppTextColor(total: number) {
  if (total >= PP_DANGER) return 'text-red-400'
  if (total >= PP_WARNING) return 'text-yellow-400'
  return 'text-green-400'
}

function ppLabel(total: number) {
  if (total >= PP_DANGER) return 'Danger — suspension risk'
  if (total >= PP_WARNING) return 'Warning — approaching limit'
  return 'Clean standing'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function MyPenaltiesPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const leagueId = searchParams.get('league_id')

  const [penalties, setPenalties] = useState<Penalty[]>([])
  const [driver, setDriver] = useState<Driver | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'expired'>('all')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
    if (status === 'authenticated') loadData()
  }, [status, leagueId])

  async function loadData() {
    setLoading(true)
    try {
      const driverRes = await fetch('/api/pitboss/drivers/me')
      const driverData = await driverRes.json()
      if (!driverRes.ok) throw new Error(driverData.error ?? 'Failed to load driver')
      setDriver(driverData.driver)

      if (!leagueId) {
        const leaguesRes = await fetch('/api/pitboss/drivers/me/leagues')
        const leaguesData = await leaguesRes.json()
        const firstLeague = leaguesData.leagues?.[0]?.league_id
        if (firstLeague) {
          router.replace(`/pitboss/penalties?league_id=${firstLeague}`)
          return
        }
      }

      if (leagueId) {
        const penRes = await fetch(`/api/pitboss/penalty-ledger?league_id=${leagueId}&driver_id=${driverData.driver.id}`)
        const penData = await penRes.json()
        if (!penRes.ok) throw new Error(penData.error ?? 'Failed to load penalties')
        setPenalties(penData.penalties ?? [])
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const activePenalties = penalties.filter(p => p.is_active && !p.removed_at)
  const activePP = activePenalties.reduce((sum, p) => sum + p.points, 0)
  const barWidth = Math.min(100, (activePP / PP_MAX) * 100)

  const filtered = penalties.filter(p => {
    if (filter === 'active') return p.is_active && !p.removed_at
    if (filter === 'expired') return !p.is_active || !!p.removed_at
    return true
  })

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading penalties…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-[#E8284A] text-center">{error}</p>
        <button onClick={() => router.back()} className="text-gray-400 underline text-sm">Go back</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">

      <div className="px-4 pt-12 pb-6 border-b border-gray-800">
        <button onClick={() => router.back()} className="text-white/50 text-sm mb-4 block">← Back</button>
        <h1 className="text-white font-bold text-2xl">Penalty Points</h1>
        <p className="text-gray-500 text-sm mt-1">
          {driver?.display_name ?? driver?.discord_username ?? 'Your record'}
        </p>
      </div>

      <div className="px-4 pt-5 space-y-6">

        {/* PP Summary card */}
        <div className="bg-gray-900 rounded-2xl p-5">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Active PP Total</p>
              <p className={`text-5xl font-black ${ppTextColor(activePP)}`}>{activePP}</p>
            </div>
            <div className="text-right">
              <p className={`text-sm font-semibold ${ppTextColor(activePP)}`}>{ppLabel(activePP)}</p>
              <p className="text-gray-600 text-xs mt-1">
                {activePenalties.length} active {activePenalties.length === 1 ? 'entry' : 'entries'}
              </p>
            </div>
          </div>

          <div className="w-full h-2.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${ppBarColor(activePP)}`}
              style={{ width: `${barWidth}%` }}
            />
          </div>

          <div className="flex justify-between mt-1.5">
            <span className="text-gray-600 text-xs">0</span>
            <span className="text-yellow-600 text-xs">{PP_WARNING} ⚠</span>
            <span className="text-red-600 text-xs">{PP_DANGER} 🚨</span>
            <span className="text-gray-600 text-xs">{PP_MAX}</span>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2">
          {(['all', 'active', 'expired'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold capitalize transition-colors ${
                filter === f ? 'bg-[#E8284A] text-white' : 'bg-gray-900 text-gray-500'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Penalty list */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-green-400 text-lg font-semibold">Clean record ✓</p>
            <p className="text-gray-600 text-sm mt-1">No penalties found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(p => (
              <div
                key={p.id}
                className={`bg-gray-900 rounded-xl px-4 py-4 border-l-4 ${
                  p.removed_at
                    ? 'border-gray-700 opacity-50'
                    : p.is_active
                    ? 'border-orange-400'
                    : 'border-gray-700 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-white text-sm flex-1">{p.reason}</p>
                  <div className="text-right flex-shrink-0">
                    <span className={`text-lg font-black ${p.is_active && !p.removed_at ? 'text-orange-400' : 'text-gray-600'}`}>
                      +{p.points}
                    </span>
                    <p className="text-gray-600 text-xs">PP</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                  <span className="text-gray-600 text-xs">Issued {formatDate(p.issued_at)}</span>
                  {p.expires_at && (
                    <span className="text-gray-600 text-xs">
                      {new Date(p.expires_at) > new Date()
                        ? `Expires ${formatDate(p.expires_at)}`
                        : `Expired ${formatDate(p.expires_at)}`}
                    </span>
                  )}
                  {p.removed_at && (
                    <span className="text-gray-500 text-xs">Removed {formatDate(p.removed_at)}</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    p.source === 'manual'
                      ? 'bg-blue-400/10 text-blue-400'
                      : 'bg-gray-800 text-gray-500'
                  }`}>
                    {p.source === 'manual' ? 'Manual' : 'Incident'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
