'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
  discord_id: string
  pp_total: number
  tier: string
}

interface Penalty {
  id: string
  driver_id: string
  points: number
  reason: string
  source: string
  issued_at: string
  expires_at: string | null
  removed_at: string | null
  is_active: boolean
  driver: Driver | null
}

interface DriverGroup {
  driver: Driver
  penalties: Penalty[]
  activePP: number
}

function avatarUrl(driver: Driver) {
  if (driver.discord_avatar) {
    return `https://cdn.discordapp.com/avatars/${driver.discord_id}/${driver.discord_avatar}.png?size=64`
  }
  return null
}

function ppColor(pp: number) {
  if (pp >= 10) return 'text-red-400'
  if (pp >= 6) return 'text-yellow-400'
  return 'text-green-400'
}

function ppBg(pp: number) {
  if (pp >= 10) return 'bg-red-400/10 border-red-400/30'
  if (pp >= 6) return 'bg-yellow-400/10 border-yellow-400/30'
  return 'bg-green-400/10 border-green-400/30'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function StewardPenaltiesInner() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const leagueId = searchParams.get('league_id') ?? ''

  const [groups, setGroups] = useState<DriverGroup[]>([])
  const [allDrivers, setAllDrivers] = useState<Driver[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null)
  const [showIssueForm, setShowIssueForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [formDriverId, setFormDriverId] = useState('')
  const [formPoints, setFormPoints] = useState(1)
  const [formReason, setFormReason] = useState('')
  const [formExpiry, setFormExpiry] = useState('')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
    if (status === 'authenticated' && leagueId) loadData()
  }, [status, leagueId])

  async function loadData() {
    setLoading(true)
    try {
      const [penRes, driverRes] = await Promise.all([
        fetch(`/api/pitboss/penalty-ledger?league_id=${leagueId}`),
        fetch(`/api/pitboss/drivers?league_id=${leagueId}`),
      ])

      const penData = await penRes.json()
      const driverData = await driverRes.json()

      if (!penRes.ok) throw new Error(penData.error ?? 'Failed to load penalties')

      const drivers: Driver[] = driverData.drivers ?? []
      setAllDrivers(drivers)

      const penalties: Penalty[] = penData.penalties ?? []
      const driverMap = new Map<string, DriverGroup>()

      for (const d of drivers) {
        driverMap.set(d.id, { driver: d, penalties: [], activePP: 0 })
      }

      for (const p of penalties) {
        if (!driverMap.has(p.driver_id)) {
          if (p.driver) driverMap.set(p.driver_id, { driver: p.driver, penalties: [], activePP: 0 })
        }
        const group = driverMap.get(p.driver_id)
        if (group) {
          group.penalties.push(p)
          if (p.is_active && !p.removed_at) group.activePP += p.points
        }
      }

      const sorted = Array.from(driverMap.values()).sort((a, b) => b.activePP - a.activePP)
      setGroups(sorted)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleIssue() {
    if (!formDriverId || !formReason || formPoints < 1) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/pitboss/penalty-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_id: formDriverId,
          league_id: leagueId,
          points: formPoints,
          reason: formReason,
          issued_by: session?.user?.id,
          expires_at: formExpiry || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setFormDriverId('')
      setFormPoints(1)
      setFormReason('')
      setFormExpiry('')
      setShowIssueForm(false)
      await loadData()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemove(penaltyId: string) {
    if (!confirm('Remove this penalty? This will deduct the PP from the driver.')) return
    try {
      const res = await fetch('/api/pitboss/penalty-ledger', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ penalty_id: penaltyId, removed_by: session?.user?.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      await loadData()
    } catch (err: any) {
      alert(err.message)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading ledger…</p>
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
      <div className="px-4 pt-12 pb-4 border-b border-gray-800 flex items-center justify-between">
        <div>
          <button onClick={() => router.back()} className="text-white/50 text-sm mb-2 block">← Back</button>
          <h1 className="text-white font-bold text-xl">Penalty Ledger</h1>
          <p className="text-gray-500 text-xs mt-0.5">{groups.length} drivers</p>
        </div>
        <button
          onClick={() => setShowIssueForm(true)}
          className="bg-[#E8284A] text-white font-bold text-sm px-4 py-2.5 rounded-xl"
        >
          + Issue
        </button>
      </div>

      {showIssueForm && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-end">
          <div className="bg-[#1A1A1A] border-t border-gray-800 w-full rounded-t-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-bold text-lg">Issue Manual Penalty</h2>
              <button onClick={() => setShowIssueForm(false)} className="text-gray-500 text-xl">✕</button>
            </div>

            <div>
              <label className="text-gray-500 text-xs uppercase tracking-widest block mb-1.5">Driver</label>
              <select
                value={formDriverId}
                onChange={e => setFormDriverId(e.target.value)}
                className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 appearance-none"
              >
                <option value="">Select driver…</option>
                {allDrivers.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.display_name ?? d.discord_username}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-gray-500 text-xs uppercase tracking-widest block mb-1.5">Penalty Points</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setFormPoints(Math.max(1, formPoints - 1))}
                  className="w-10 h-10 bg-gray-800 rounded-xl text-white font-bold text-lg flex items-center justify-center"
                >
                  −
                </button>
                <span className="text-white font-black text-2xl w-8 text-center">{formPoints}</span>
                <button
                  onClick={() => setFormPoints(Math.min(25, formPoints + 1))}
                  className="w-10 h-10 bg-gray-800 rounded-xl text-white font-bold text-lg flex items-center justify-center"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <label className="text-gray-500 text-xs uppercase tracking-widest block mb-1.5">Reason</label>
              <textarea
                value={formReason}
                onChange={e => setFormReason(e.target.value)}
                placeholder="Describe the infraction…"
                rows={3}
                className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 resize-none placeholder-gray-600"
              />
            </div>

            <div>
              <label className="text-gray-500 text-xs uppercase tracking-widest block mb-1.5">
                Expiry Date <span className="text-gray-600 normal-case">(optional)</span>
              </label>
              <input
                type="date"
                value={formExpiry}
                onChange={e => setFormExpiry(e.target.value)}
                className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700"
              />
            </div>

            <button
              onClick={handleIssue}
              disabled={!formDriverId || !formReason || submitting}
              className="w-full bg-[#E8284A] disabled:opacity-40 text-white font-bold py-4 rounded-xl"
            >
              {submitting ? 'Issuing…' : `Issue ${formPoints} PP`}
            </button>
          </div>
        </div>
      )}

      <div className="px-4 pt-4 space-y-3">
        {groups.map(({ driver, penalties, activePP }) => {
          const isExpanded = expandedDriver === driver.id
          const avatar = avatarUrl(driver)
          const displayName = driver.display_name ?? driver.discord_username

          return (
            <div key={driver.id} className="bg-gray-900 rounded-2xl overflow-hidden">
              <button
                onClick={() => setExpandedDriver(isExpanded ? null : driver.id)}
                className="w-full flex items-center gap-3 px-4 py-3.5"
              >
                <div className="w-9 h-9 rounded-xl overflow-hidden bg-gray-800 flex-shrink-0">
                  {avatar ? (
                    <img src={avatar} alt={displayName} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white text-sm font-bold">
                      {displayName[0].toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="flex-1 text-left min-w-0">
                  <p className="text-white font-semibold text-sm truncate">{displayName}</p>
                  <p className="text-gray-600 text-xs">{penalties.length} {penalties.length === 1 ? 'entry' : 'entries'}</p>
                </div>

                <div className={`px-3 py-1 rounded-full border text-sm font-black ${ppBg(activePP)} ${ppColor(activePP)}`}>
                  {activePP} PP
                </div>

                <span className="text-gray-600 text-xs ml-1">{isExpanded ? '▲' : '▼'}</span>
              </button>

              {isExpanded && (
                <div className="border-t border-gray-800 divide-y divide-gray-800">
                  {penalties.length === 0 ? (
                    <p className="text-gray-600 text-sm px-4 py-4">No penalties on record.</p>
                  ) : (
                    penalties.map(p => (
                      <div key={p.id} className={`px-4 py-3 ${p.removed_at || !p.is_active ? 'opacity-40' : ''}`}>
                        <div className="flex items-start gap-2">
                          <p className="text-white text-sm flex-1">{p.reason}</p>
                          <span className="text-orange-400 font-bold text-sm flex-shrink-0">+{p.points} PP</span>
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            <span className="text-gray-600 text-xs">{formatDate(p.issued_at)}</span>
                            {p.expires_at && (
                              <span className="text-gray-600 text-xs">Exp. {formatDate(p.expires_at)}</span>
                            )}
                            <span className={`text-xs ${p.source === 'manual' ? 'text-blue-400' : 'text-gray-600'}`}>
                              {p.source === 'manual' ? 'Manual' : 'Incident'}
                            </span>
                          </div>
                          {p.source === 'manual' && p.is_active && !p.removed_at && (
                            <button
                              onClick={() => handleRemove(p.id)}
                              className="text-red-400 text-xs underline flex-shrink-0"
                            >
                              Remove
                            </button>
                          )}
                          {p.source !== 'manual' && (
                            <span className="text-gray-700 text-xs flex-shrink-0">🔒 locked</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function StewardPenaltiesPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading ledger…</p>
      </div>
    }>
      <StewardPenaltiesInner />
    </Suspense>
  )
}
