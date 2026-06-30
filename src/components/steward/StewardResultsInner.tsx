'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
  tier: string | null
}

interface ResultRow {
  driver_id: string
  driver: Driver | null
  qualifying_position: number | null
  finish_position: number | null
  dnf: boolean
  dnf_reason: string
  fastest_lap: boolean
  points_earned: number
  penalty_points_added: number
}

interface League {
  id: string
  name: string
  slug: string
}

interface ExistingResult {
  id: string
  driver_id: string
  finish_position: number | null
  qualifying_position: number | null
  dnf: boolean
  dnf_reason: string | null
  fastest_lap: boolean
  points_earned: number
  penalty_points_added: number
  driver: Driver | null
}

export function StewardResultsInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { status }   = useSession()

  const [leagues, setLeagues]         = useState<League[]>([])
  const [league, setLeague]           = useState<League | null>(null)
  const [leagueDrivers, setLeagueDrivers] = useState<Driver[]>([])
  const [season, setSeason]           = useState('')
  const [round, setRound]             = useState('')
  const [track, setTrack]             = useState('')
  const [rows, setRows]               = useState<ResultRow[]>([])
  const [existing, setExisting]       = useState<ExistingResult[]>([])
  const [loading, setLoading]         = useState(true)
  const [loadingDrivers, setLoadingDrivers] = useState(false)
  const [submitting, setSubmitting]   = useState(false)
  const [saved, setSaved]             = useState(false)
  const [error, setError]             = useState<string | null>(null)

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
          if (match) selectLeague(match)
        }
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  async function selectLeague(l: League) {
    setLeague(l)
    setLoadingDrivers(true)
    try {
      // Pull drivers who have penalties or licences in the league as a proxy for membership
      const res = await fetch(`/api/pitboss/penalty-ledger/steward?league_id=${l.id}`)
      const data = await res.json()
      const seen = new Map<string, Driver>()
      ;(data.penalties ?? []).forEach((p: any) => {
        if (p.driver && !seen.has(p.driver_id)) seen.set(p.driver_id, p.driver)
      })
      // Also pull drivers via licences endpoint if available
      const licRes = await fetch(`/api/pitboss/licences?league_id=${l.id}`)
      if (licRes.ok) {
        const licData = await licRes.json()
        ;(licData.licences ?? []).forEach((lic: any) => {
          if (lic.driver && !seen.has(lic.driver_id)) seen.set(lic.driver_id, lic.driver)
        })
      }
      setLeagueDrivers(Array.from(seen.values()))
    } catch {
      // non-fatal, steward can still manually enter
    } finally {
      setLoadingDrivers(false)
    }
  }

  async function loadExisting() {
    if (!league || !season || !round) return
    setError(null)
    try {
      const res = await fetch(
        `/api/pitboss/results?league_id=${league.id}&season=${season}&round=${round}`
      )
      const data = await res.json()
      const results: ExistingResult[] = data.results ?? []
      setExisting(results)

      if (results.length > 0) {
        // Pre-populate rows from existing
        setRows(results.map(r => ({
          driver_id:            r.driver_id,
          driver:               r.driver,
          qualifying_position:  r.qualifying_position,
          finish_position:      r.finish_position,
          dnf:                  r.dnf,
          dnf_reason:           r.dnf_reason ?? '',
          fastest_lap:          r.fastest_lap,
          points_earned:        r.points_earned,
          penalty_points_added: r.penalty_points_added,
        })))
      } else {
        // Build blank rows from known drivers
        setRows(leagueDrivers.map(d => ({
          driver_id:            d.id,
          driver:               d,
          qualifying_position:  null,
          finish_position:      null,
          dnf:                  false,
          dnf_reason:           '',
          fastest_lap:          false,
          points_earned:        0,
          penalty_points_added: 0,
        })))
      }
    } catch (e: any) {
      setError(e.message)
    }
  }

  function updateRow(idx: number, patch: Partial<ResultRow>) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }

  function addRow() {
    setRows(prev => [...prev, {
      driver_id: '', driver: null,
      qualifying_position: null, finish_position: null,
      dnf: false, dnf_reason: '', fastest_lap: false,
      points_earned: 0, penalty_points_added: 0,
    }])
  }

  async function handleSave() {
    if (!league || !season || !round) return
    setSubmitting(true)
    setSaved(false)
    setError(null)

    const validRows = rows.filter(r => r.driver_id)

    try {
      if (existing.length > 0) {
        // Update each existing result
        await Promise.all(
          validRows.map(r => {
            const match = existing.find(e => e.driver_id === r.driver_id)
            if (!match) return Promise.resolve()
            return fetch('/api/pitboss/results', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                result_id:            match.id,
                league_id:            league.id,
                finish_position:      r.finish_position,
                qualifying_position:  r.qualifying_position,
                dnf:                  r.dnf,
                dnf_reason:           r.dnf_reason || null,
                fastest_lap:          r.fastest_lap,
                points_earned:        r.points_earned,
                penalty_points_added: r.penalty_points_added,
                track:                track || null,
              }),
            })
          })
        )
      } else {
        const res = await fetch('/api/pitboss/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            league_id: league.id,
            rows: validRows.map(r => ({
              ...r,
              season,
              round: parseInt(round),
              track: track || null,
            })),
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to save results')
      }
      setSaved(true)
      await loadExisting()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  const isEditing = existing.length > 0

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button
        onClick={() => {
          if (rows.length > 0) { setRows([]); setExisting([]) }
          else if (league) { setLeague(null) }
          else router.back()
        }}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">Race Results</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {league ? league.name : 'Select a league'}
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {saved && (
        <div className="mb-4 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3">
          <p className="text-sm text-green-400">Results saved ✓</p>
        </div>
      )}

      {/* League selector */}
      {!league && (
        <div className="flex flex-col gap-3">
          {leagues.map(l => (
            <button
              key={l.id}
              onClick={() => selectLeague(l)}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <p className="text-sm font-bold text-white">{l.name}</p>
              <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">{l.slug}</p>
            </button>
          ))}
        </div>
      )}

      {/* Round picker */}
      {league && rows.length === 0 && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block uppercase tracking-widest">Season</label>
            <input
              value={season}
              onChange={e => setSeason(e.target.value)}
              placeholder="e.g. 2027"
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2 placeholder:text-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block uppercase tracking-widest">Round</label>
            <input
              type="number"
              value={round}
              onChange={e => setRound(e.target.value)}
              placeholder="1"
              min={1}
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2 placeholder:text-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block uppercase tracking-widest">Track (optional)</label>
            <input
              value={track}
              onChange={e => setTrack(e.target.value)}
              placeholder="e.g. Monza"
              className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-2 placeholder:text-white/20"
            />
          </div>
          <button
            onClick={loadExisting}
            disabled={!season || !round || loadingDrivers}
            className="w-full py-2.5 rounded-xl bg-rise-red text-white text-sm font-bold disabled:opacity-40 active:scale-95 transition-transform"
          >
            {loadingDrivers ? 'Loading…' : 'Load Round'}
          </button>
        </div>
      )}

      {/* Results grid */}
      {league && rows.length > 0 && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-white/40 uppercase tracking-widest">
              {isEditing ? 'Editing' : 'New'} · S{season} R{round}{track ? ` · ${track}` : ''}
            </p>
            <p className="text-xs text-white/30">{rows.filter(r => r.driver_id).length} drivers</p>
          </div>

          <div className="space-y-2 mb-6">
            {rows.map((row, idx) => {
              const name = row.driver?.display_name ?? row.driver?.discord_username ?? '—'
              return (
                <div key={idx} className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
                  {/* Driver selector (for new rows without a driver) */}
                  {!row.driver_id ? (
                    <select
                      value={row.driver_id}
                      onChange={e => {
                        const d = leagueDrivers.find(d => d.id === e.target.value) ?? null
                        updateRow(idx, { driver_id: e.target.value, driver: d })
                      }}
                      className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-1.5"
                    >
                      <option value="">Select driver…</option>
                      {leagueDrivers.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.display_name ?? d.discord_username}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-white text-sm font-bold">{name}</p>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-white/30 block mb-0.5">Qual Pos</label>
                      <input
                        type="number" min={1}
                        value={row.qualifying_position ?? ''}
                        onChange={e => updateRow(idx, { qualifying_position: parseInt(e.target.value) || null })}
                        className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-white/30 block mb-0.5">Finish Pos</label>
                      <input
                        type="number" min={1}
                        value={row.finish_position ?? ''}
                        onChange={e => updateRow(idx, { finish_position: parseInt(e.target.value) || null })}
                        disabled={row.dnf}
                        className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-2 py-1 disabled:opacity-30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-white/30 block mb-0.5">Points</label>
                      <input
                        type="number" min={0}
                        value={row.points_earned}
                        onChange={e => updateRow(idx, { points_earned: parseFloat(e.target.value) || 0 })}
                        className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-white/30 block mb-0.5">Pen. PP</label>
                      <input
                        type="number" min={0}
                        value={row.penalty_points_added}
                        onChange={e => updateRow(idx, { penalty_points_added: parseInt(e.target.value) || 0 })}
                        className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-2 py-1"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-white/50">
                      <input
                        type="checkbox"
                        checked={row.dnf}
                        onChange={e => updateRow(idx, { dnf: e.target.checked, finish_position: e.target.checked ? null : row.finish_position })}
                        className="accent-rise-red"
                      />
                      DNF
                    </label>
                    <label className="flex items-center gap-2 text-xs text-white/50">
                      <input
                        type="checkbox"
                        checked={row.fastest_lap}
                        onChange={e => updateRow(idx, { fastest_lap: e.target.checked })}
                        className="accent-rise-red"
                      />
                      Fastest Lap
                    </label>
                  </div>

                  {row.dnf && (
                    <input
                      value={row.dnf_reason}
                      onChange={e => updateRow(idx, { dnf_reason: e.target.value })}
                      placeholder="DNF reason…"
                      className="w-full rounded-lg bg-white/10 border border-white/10 text-white text-sm px-3 py-1.5 placeholder:text-white/20"
                    />
                  )}
                </div>
              )
            })}
          </div>

          <button
            onClick={addRow}
            className="w-full py-2 rounded-xl border border-white/10 text-white/40 text-sm mb-4 active:scale-95 transition-transform"
          >
            + Add Driver
          </button>

          <button
            onClick={handleSave}
            disabled={submitting || rows.filter(r => r.driver_id).length === 0}
            className="w-full py-3 rounded-xl bg-rise-red text-white font-bold disabled:opacity-40 active:scale-95 transition-transform"
          >
            {submitting ? 'Saving…' : isEditing ? 'Update Results' : 'Save Results'}
          </button>
        </>
      )}
    </main>
  )
}
