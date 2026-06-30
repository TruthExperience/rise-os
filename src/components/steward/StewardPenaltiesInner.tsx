'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
  pp_total: number
  tier: string | null
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

interface League {
  id: string
  name: string
  slug: string
}

function ppColor(total: number) {
  if (total >= 10) return 'text-red-400'
  if (total >= 6)  return 'text-yellow-400'
  return 'text-green-400'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function StewardPenaltiesInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { status }   = useSession()

  const [leagues, setLeagues]         = useState<League[]>([])
  const [league, setLeague]           = useState<League | null>(null)
  const [penalties, setPenalties]     = useState<Penalty[]>([])
  const [drivers, setDrivers]         = useState<Driver[]>([])
  const [loading, setLoading]         = useState(true)
  const [loadingPen, setLoadingPen]   = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [showForm, setShowForm]       = useState(false)
  const [submitting, setSubmitting]   = useState(false)

  // Issue form state
  const [formDriverId, setFormDriverId]   = useState('')
  const [formPoints, setFormPoints]       = useState(1)
  const [formReason, setFormReason]       = useState('')
  const [formExpires, setFormExpires]     = useState('')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then(r => r.json())
      .then(data => {
        const all = (data.leagues ?? data) as League[]
        setLeagues(all)
        const paramId = searchParams.get('league_id')
        if (paramId) {
          const match = all.find(l => l.id === paramId)
          if (match) loadLeague(match)
        }
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  async function loadLeague(l: League) {
    setLeague(l)
    setLoadingPen(true)
    setError(null)
    try {
      const [penRes, driversRes] = await Promise.all([
        fetch(`/api/pitboss/penalty-ledger/steward?league_id=${l.id}`),
        fetch(`/api/pitboss/drivers/me/leagues`), // fallback; fetch all league drivers below
      ])
      const penData = await penRes.json()
      if (!penRes.ok) throw new Error(penData.error ?? 'Failed to load penalties')
      setPenalties(penData.penalties ?? [])

      // Pull unique drivers from penalties + fetch full driver list for form
      const res2 = await fetch(`/api/pitboss/penalty-ledger/steward?league_id=${l.id}&active_only=false`)
      const d2 = await res2.json()
      const seen = new Map<string, Driver>()
      ;(d2.penalties ?? []).forEach((p: Penalty) => {
        if (p.driver && !seen.has(p.driver_id)) seen.set(p.driver_id, p.driver)
      })
      setDrivers(Array.from(seen.values()))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingPen(false)
    }
  }

  async function handleIssue() {
    if (!league || !formDriverId || !formReason.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/pitboss/penalty-ledger/steward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id:  league.id,
          driver_id:  formDriverId,
          points:     formPoints,
          reason:     formReason.trim(),
          expires_at: formExpires || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to issue penalty')
      setShowForm(false)
      setFormDriverId('')
      setFormPoints(1)
      setFormReason('')
      setFormExpires('')
      await loadLeague(league)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemove(penaltyId: string) {
    if (!league) return
    setError(null)
    try {
      const res = await fetch('/api/pitboss/penalty-ledger/steward', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ penalty_id: penaltyId, league_id: league.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to remove penalty')
      await loadLeague(league)
    } catch (e: any) {
      setError(e.message)
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
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button
        onClick={() => {
          if (league) { setLeague(null); setPenalties([]) }
          else router.back()
        }}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-white">Penalty Ledger</h1>
          <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
            {league ? league.name : 'Select a league'}
          </p>
        </div>
        {league && (
          <button
            onClick={() => setShowForm(v => !v)}
            className="px-4 py-2 rounded-xl bg-rise-red text-white text-sm font-bold active:scale-95 transition-transform"
          >
            {showForm ? 'Cancel' : '+ Issue'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {/* League selector */}
      {!league && (
        <div className="flex flex-col gap-3">
          {leagues.map(l => (
            <button
              key={l.id}
              onClick={() => loadLeague(l)}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <p className="text-sm font-bold text-white">{l.name}</p>
              <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">{l.slug}</p>
            </button>
          ))}
        </div>
      )}

      {/* Issue form */}
      {league && showForm && (
        <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
          <p className="text-xs text-white/40 uppercase tracking-widest font-bold">Issue Penalty</p>

          <div>
            <label className="text-xs text-white/40 mb-1 block">Driver</label>
            <select
              value={formDriverId}
              onChange={e => setFormDriverId(e.target.value)}
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Select driver…</option>
              {drivers.map(d => (
                <option key={d.id} value={d.id}>
                  {d.display_name ?? d.discord_username}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-white/40 mb-1 block">Points (1–25)</label>
            <input
              type="number"
              min={1}
              max={25}
              value={formPoints}
              onChange={e => setFormPoints(parseInt(e.target.value) || 1)}
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2"
            />
          </div>

          <div>
            <label className="text-xs text-white/40 mb-1 block">Reason</label>
            <textarea
              value={formReason}
              onChange={e => setFormReason(e.target.value)}
              rows={3}
              placeholder="Describe the infraction…"
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2 resize-none placeholder:text-white/20"
            />
          </div>

          <div>
            <label className="text-xs text-white/40 mb-1 block">Expires (optional)</label>
            <input
              type="date"
              value={formExpires}
              onChange={e => setFormExpires(e.target.value)}
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2"
            />
          </div>

          <button
            onClick={handleIssue}
            disabled={submitting || !formDriverId || !formReason.trim()}
            className="w-full py-2.5 rounded-xl bg-rise-red text-white text-sm font-bold disabled:opacity-40 active:scale-95 transition-transform"
          >
            {submitting ? 'Issuing…' : 'Issue Penalty'}
          </button>
        </div>
      )}

      {/* Penalty list */}
      {league && (
        <>
          {loadingPen && (
            <div className="flex justify-center mt-12">
              <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
            </div>
          )}

          {!loadingPen && penalties.length === 0 && (
            <p className="text-white/30 text-sm text-center mt-12">No penalties on record.</p>
          )}

          {!loadingPen && penalties.map(p => {
            const driverName = p.driver?.display_name ?? p.driver?.discord_username ?? 'Unknown'
            return (
              <div
                key={p.id}
                className={`rounded-xl border border-white/10 bg-white/5 p-4 mb-3 ${p.removed_at ? 'opacity-40' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-white font-bold text-sm">{driverName}</p>
                      {p.driver && (
                        <span className={`text-xs font-black ${ppColor(p.driver.pp_total)}`}>
                          {p.driver.pp_total} PP
                        </span>
                      )}
                    </div>
                    <p className="text-white/60 text-xs">{p.reason}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                      <span className="text-white/20 text-[10px]">Issued {formatDate(p.issued_at)}</span>
                      {p.expires_at && (
                        <span className="text-white/20 text-[10px]">Expires {formatDate(p.expires_at)}</span>
                      )}
                      {p.removed_at && (
                        <span className="text-white/30 text-[10px]">Removed {formatDate(p.removed_at)}</span>
                      )}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        p.source === 'manual'
                          ? 'bg-blue-400/10 text-blue-400'
                          : 'bg-white/10 text-white/40'
                      }`}>
                        {p.source}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-2">
                    <span className={`text-2xl font-black ${p.is_active && !p.removed_at ? 'text-orange-400' : 'text-white/20'}`}>
                      +{p.points}
                    </span>
                    {p.source === 'manual' && !p.removed_at && (
                      <button
                        onClick={() => handleRemove(p.id)}
                        className="text-[10px] text-rise-red/70 hover:text-rise-red underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </>
      )}
    </main>
  )
}
