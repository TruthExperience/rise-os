'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  CareerPath,
  CareerRaceResult,
  CareerSeries,
  RaceType,
  CareerSummary,
  defaultPoints,
  seasonBreakdown,
  sortResults,
  summarize,
} from '@/lib/pitboss/career-tracker'

interface CareerDriver {
  id: string
  driver_name: string
  overall: number
}

interface Track {
  id: string
  name: string
}

type View = CareerSeries | 'career'

const INPUT =
  'w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#E8284A]'

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-white font-bold text-base uppercase tracking-widest">{title}</h2>
      {count !== undefined && (
        <span className="bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded-full">{count}</span>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-center">
      <p className="text-white font-black text-lg leading-tight">{value}</p>
      <p className="text-gray-500 text-[10px] uppercase tracking-wide">{label}</p>
    </div>
  )
}

const fmt = (n: number | null) => (n === null ? '—' : String(n))
const seriesLabel = (s: CareerSeries) => (s === 'f2' ? 'F2' : 'F1')

function SummaryGrid({ s, showPoints }: { s: CareerSummary; showPoints: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Stat label="Races" value={s.races} />
      <Stat label="Wins" value={s.wins} />
      <Stat label="Podiums" value={s.podiums} />
      <Stat label="Poles" value={s.poles} />
      <Stat label="Front rows" value={s.frontRows} />
      <Stat label="Fast laps" value={s.fastestLaps} />
      <Stat label="Top 5" value={s.top5} />
      <Stat label="Top 10" value={s.top10} />
      <Stat label="DNFs" value={s.dnfs} />
      <Stat label="Avg quali" value={fmt(s.avgQuali)} />
      <Stat label="Avg finish" value={fmt(s.avgFinish)} />
      <Stat
        label="Places +/-"
        value={s.avgPlacesGained === null ? '—' : `${s.avgPlacesGained > 0 ? '+' : ''}${s.avgPlacesGained}`}
      />
      <Stat label="Best quali" value={fmt(s.bestQuali)} />
      <Stat label="Best finish" value={fmt(s.bestFinish)} />
      <Stat label={showPoints ? 'Points' : 'Sprints'} value={showPoints ? s.points : s.sprints} />
    </div>
  )
}

export default function CareerTrackerPage() {
  const { status } = useSession()
  const router = useRouter()

  const [drivers, setDrivers] = useState<CareerDriver[]>([])
  const [tracks, setTracks] = useState<Track[]>([])
  const [driverId, setDriverId] = useState('')
  const [careerPath, setCareerPath] = useState<CareerPath>('f2_f1')
  const [results, setResults] = useState<CareerRaceResult[]>([])
  const [view, setView] = useState<View>('f2')
  const [loadingDrivers, setLoadingDrivers] = useState(true)
  const [loadingResults, setLoadingResults] = useState(false)
  const [savingPath, setSavingPath] = useState(false)
  const [error, setError] = useState('')
  const [deletingDriver, setDeletingDriver] = useState(false)

  // Add-result form
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fSeries, setFSeries] = useState<CareerSeries>('f2')
  const [fSeason, setFSeason] = useState('1')
  const [fRound, setFRound] = useState('1')
  const [fType, setFType] = useState<RaceType>('race')
  const [fTrackId, setFTrackId] = useState('')
  const [fTrackName, setFTrackName] = useState('')
  const [fTeam, setFTeam] = useState('')
  const [fQuali, setFQuali] = useState('')
  const [fGrid, setFGrid] = useState('')
  const [fFinish, setFFinish] = useState('')
  const [fDnf, setFDnf] = useState(false)
  const [fFastest, setFFastest] = useState(false)
  const [fPoints, setFPoints] = useState('')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Drivers + tracks once; honour ?driver=<id> from the setups page link.
  useEffect(() => {
    const wanted =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('driver') ?? '' : ''
    fetch('/api/pitboss/setups/career-drivers')
      .then((r) => r.json())
      .then((d) => {
        const list: CareerDriver[] = d.career_drivers ?? []
        setDrivers(list)
        if (wanted && list.some((x) => x.id === wanted)) setDriverId(wanted)
      })
      .catch(() => setDrivers([]))
      .finally(() => setLoadingDrivers(false))
    fetch('/api/pitboss/setups/options')
      .then((r) => r.json())
      .then((d) => setTracks(d.tracks ?? []))
      .catch(() => setTracks([]))
  }, [])

  // Load a driver's path + results whenever the pick changes.
  useEffect(() => {
    setResults([])
    setError('')
    if (!driverId) return
    setLoadingResults(true)
    fetch(`/api/pitboss/setups/career-drivers/${driverId}/results`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error ?? 'Failed to load results')
        const path: CareerPath = d.career_path === 'f1_only' ? 'f1_only' : 'f2_f1'
        const rs: CareerRaceResult[] = sortResults(d.results ?? [])
        setCareerPath(path)
        setResults(rs)
        const hasF1 = rs.some((x) => x.series === 'f1')
        const startView: View = path === 'f1_only' || hasF1 ? 'f1' : 'f2'
        setView(startView)
        setFSeries(startView === 'f2' ? 'f2' : 'f1')
        const last = rs[0]
        if (last) {
          setFSeason(String(last.season))
          setFRound(String(last.round + 1))
          setFTeam(last.team_name ?? '')
          setFSeries(last.series)
        } else {
          setFSeason('1')
          setFRound('1')
          setFTeam('')
        }
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoadingResults(false))
  }, [driverId])

  const selected = drivers.find((d) => d.id === driverId)
  const hasF2 = careerPath === 'f2_f1' || results.some((r) => r.series === 'f2')
  const tabs: View[] = hasF2 ? ['f2', 'f1', 'career'] : ['f1']
  const activeView: View = tabs.includes(view) ? view : tabs[0]

  const scoped = useMemo(
    () => (activeView === 'career' ? results : results.filter((r) => r.series === activeView)),
    [results, activeView]
  )
  const summary = useMemo(() => summarize(scoped), [scoped])
  const seasons = useMemo(() => seasonBreakdown(scoped), [scoped])

  const finishNum = fFinish.trim() ? Number(fFinish) : null
  const qualiNum = fQuali.trim() ? Number(fQuali) : null
  const autoPoints = defaultPoints({
    series: fSeries,
    raceType: fType,
    finish: fDnf ? null : finishNum,
    dnf: fDnf,
    fastestLap: fFastest,
    quali: qualiNum,
  })

  async function changePath(next: CareerPath) {
    if (!driverId || next === careerPath) return
    setSavingPath(true)
    setError('')
    try {
      const res = await fetch(`/api/pitboss/setups/career-drivers/${driverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ career_path: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to update career path')
      setCareerPath(next)
      if (next === 'f1_only' && !results.some((r) => r.series === 'f2')) {
        setView('f1')
        setFSeries('f1')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSavingPath(false)
    }
  }

  async function saveResult() {
    if (!driverId) return
    setSaving(true)
    setError('')
    try {
      const num = (v: string) => (v.trim() ? Number(v) : null)
      const res = await fetch(`/api/pitboss/setups/career-drivers/${driverId}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series: fSeries,
          season: Number(fSeason),
          round: Number(fRound),
          race_type: fType,
          track_id: fTrackId || null,
          track_name: !fTrackId && fTrackName.trim() ? fTrackName.trim() : null,
          team_name: fTeam.trim() || null,
          quali_position: num(fQuali),
          grid_position: num(fGrid),
          finish_position: fDnf ? null : num(fFinish),
          dnf: fDnf,
          fastest_lap: fFastest,
          points: num(fPoints),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save result')
      setResults((prev) => sortResults([data, ...prev]))
      // Ready for the next entry: sprint -> same round's main race, main race -> next round.
      if (fType === 'sprint') {
        setFType('race')
      } else {
        setFRound(String(Number(fRound) + 1))
      }
      setFTrackId('')
      setFTrackName('')
      setFQuali('')
      setFGrid('')
      setFFinish('')
      setFDnf(false)
      setFFastest(false)
      setFPoints('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteResult(r: CareerRaceResult) {
    if (!window.confirm(`Delete ${seriesLabel(r.series)} S${r.season} R${r.round} ${r.race_type}?`)) return
    setError('')
    try {
      const res = await fetch(`/api/pitboss/setups/career-drivers/${driverId}/results/${r.id}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete result')
      setResults((prev) => prev.filter((x) => x.id !== r.id))
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function deleteDriver() {
    if (!driverId || !selected) return
    if (
      !window.confirm(
        `Delete ${selected.driver_name}? This also deletes all their race results and stat history. This cannot be undone.`
      )
    )
      return
    setDeletingDriver(true)
    setError('')
    try {
      const res = await fetch(`/api/pitboss/setups/career-drivers/${driverId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete driver')
      setDrivers((prev) => prev.filter((d) => d.id !== driverId))
      setResults([])
      setDriverId('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDeletingDriver(false)
    }
  }

  if (status === 'loading' || loadingDrivers) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">
      <div className="px-4 pt-8 pb-4">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-4">
          ← Back
        </button>
        <h1 className="text-white font-black text-2xl">Career Tracker</h1>
        <p className="text-gray-500 text-sm mt-1">Qualifying and race results across your F2 and F1 career.</p>
      </div>

      <div className="px-4 space-y-6">
        <div>
          <SectionHeader title="Driver" />
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
          >
            <option value="">Select a career mode driver…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.driver_name} — {d.overall} OVR
              </option>
            ))}
          </select>
          {selected && (
            <button
              onClick={deleteDriver}
              disabled={deletingDriver}
              className="mt-2 text-xs text-red-400/80 hover:text-red-300 disabled:opacity-50"
            >
              {deletingDriver ? 'Deleting…' : `Delete ${selected.driver_name}`}
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-red-300 text-xs">{error}</div>
        )}

        {selected && (
          <>
            <div>
              <SectionHeader title="Career path" />
              <div className="flex gap-2">
                {(['f2_f1', 'f1_only'] as CareerPath[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => changePath(p)}
                    disabled={savingPath}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold border transition-colors disabled:opacity-40 ${
                      careerPath === p
                        ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                        : 'border-gray-800 bg-gray-900 text-gray-500'
                    }`}
                  >
                    {p === 'f2_f1' ? 'F2 → F1' : 'F1 only'}
                  </button>
                ))}
              </div>
            </div>

            {loadingResults ? (
              <p className="text-gray-500 text-xs">Loading results…</p>
            ) : (
              <>
                {tabs.length > 1 && (
                  <div className="flex gap-2">
                    {tabs.map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setView(t)
                          if (t !== 'career') setFSeries(t)
                        }}
                        className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold border transition-colors ${
                          activeView === t
                            ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                            : 'border-gray-800 bg-gray-900 text-gray-500'
                        }`}
                      >
                        {t === 'career' ? 'Career' : seriesLabel(t)}
                      </button>
                    ))}
                  </div>
                )}

                <div>
                  <SectionHeader
                    title={activeView === 'career' ? 'Career totals' : `${seriesLabel(activeView)} stats`}
                  />
                  {scoped.length === 0 ? (
                    <p className="text-gray-500 text-xs">No results logged yet.</p>
                  ) : (
                    <SummaryGrid s={summary} showPoints={activeView !== 'career'} />
                  )}
                </div>

                {seasons.length > 0 && (
                  <div>
                    <SectionHeader title="By season" />
                    <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-x-auto">
                      <table className="w-full text-xs text-gray-300">
                        <thead>
                          <tr className="text-gray-500 uppercase text-[10px]">
                            <th className="text-left px-3 py-2">Season</th>
                            <th className="px-2 py-2">R</th>
                            <th className="px-2 py-2">W</th>
                            <th className="px-2 py-2">Pod</th>
                            <th className="px-2 py-2">Pole</th>
                            <th className="px-2 py-2">DNF</th>
                            <th className="px-2 py-2">Avg Q</th>
                            <th className="px-2 py-2">Avg F</th>
                            {activeView !== 'career' && <th className="px-2 py-2">Pts</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {seasons.map((row) => (
                            <tr key={row.key} className="border-t border-gray-800 text-center">
                              <td className="text-left px-3 py-2 text-white whitespace-nowrap">
                                S{row.season} {seriesLabel(row.series)}
                                {row.team && <span className="text-gray-500"> · {row.team}</span>}
                              </td>
                              <td className="px-2 py-2">{row.summary.races}</td>
                              <td className="px-2 py-2">{row.summary.wins}</td>
                              <td className="px-2 py-2">{row.summary.podiums}</td>
                              <td className="px-2 py-2">{row.summary.poles}</td>
                              <td className="px-2 py-2">{row.summary.dnfs}</td>
                              <td className="px-2 py-2">{fmt(row.summary.avgQuali)}</td>
                              <td className="px-2 py-2">{fmt(row.summary.avgFinish)}</td>
                              {activeView !== 'career' && (
                                <td className="px-2 py-2 text-white font-semibold">{row.summary.points}</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div>
                  <SectionHeader title="Log a result" />
                  {!showForm ? (
                    <button
                      onClick={() => setShowForm(true)}
                      className="w-full rounded-xl bg-[#E8284A] py-3 text-sm font-bold text-white"
                    >
                      + Add qualifying & race result
                    </button>
                  ) : (
                    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
                      {hasF2 && (
                        <div className="flex gap-2">
                          {(['f2', 'f1'] as CareerSeries[]).map((s) => (
                            <button
                              key={s}
                              onClick={() => setFSeries(s)}
                              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold border ${
                                fSeries === s
                                  ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                                  : 'border-gray-700 bg-gray-800 text-gray-500'
                              }`}
                            >
                              {seriesLabel(s)}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-2">
                        <label className="text-gray-500 text-[10px] uppercase">
                          Season
                          <input
                            type="number"
                            inputMode="numeric"
                            value={fSeason}
                            onChange={(e) => setFSeason(e.target.value)}
                            className={INPUT}
                          />
                        </label>
                        <label className="text-gray-500 text-[10px] uppercase">
                          Round
                          <input
                            type="number"
                            inputMode="numeric"
                            value={fRound}
                            onChange={(e) => setFRound(e.target.value)}
                            className={INPUT}
                          />
                        </label>
                        <label className="text-gray-500 text-[10px] uppercase">
                          Race
                          <select
                            value={fType}
                            onChange={(e) => setFType(e.target.value as RaceType)}
                            className={INPUT}
                          >
                            <option value="race">{fSeries === 'f2' ? 'Feature' : 'Race'}</option>
                            <option value="sprint">Sprint</option>
                          </select>
                        </label>
                      </div>

                      {tracks.length > 0 ? (
                        <select value={fTrackId} onChange={(e) => setFTrackId(e.target.value)} className={INPUT}>
                          <option value="">Select track…</option>
                          {tracks.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={fTrackName}
                          onChange={(e) => setFTrackName(e.target.value)}
                          placeholder="Track name"
                          className={INPUT}
                        />
                      )}

                      <input
                        value={fTeam}
                        onChange={(e) => setFTeam(e.target.value)}
                        placeholder="Team (optional)"
                        className={INPUT}
                      />

                      <div className="grid grid-cols-3 gap-2">
                        <label className="text-gray-500 text-[10px] uppercase">
                          Quali
                          <input
                            type="number"
                            inputMode="numeric"
                            value={fQuali}
                            onChange={(e) => setFQuali(e.target.value)}
                            placeholder="P"
                            className={INPUT}
                          />
                        </label>
                        <label className="text-gray-500 text-[10px] uppercase">
                          Grid
                          <input
                            type="number"
                            inputMode="numeric"
                            value={fGrid}
                            onChange={(e) => setFGrid(e.target.value)}
                            placeholder="P"
                            className={INPUT}
                          />
                        </label>
                        <label className="text-gray-500 text-[10px] uppercase">
                          Finish
                          <input
                            type="number"
                            inputMode="numeric"
                            value={fDnf ? '' : fFinish}
                            onChange={(e) => setFFinish(e.target.value)}
                            disabled={fDnf}
                            placeholder={fDnf ? 'DNF' : 'P'}
                            className={`${INPUT} disabled:opacity-40`}
                          />
                        </label>
                      </div>

                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-gray-300 text-xs">
                          <input
                            type="checkbox"
                            checked={fDnf}
                            onChange={(e) => setFDnf(e.target.checked)}
                            className="accent-[#E8284A]"
                          />
                          DNF
                        </label>
                        <label className="flex items-center gap-2 text-gray-300 text-xs">
                          <input
                            type="checkbox"
                            checked={fFastest}
                            onChange={(e) => setFFastest(e.target.checked)}
                            className="accent-[#E8284A]"
                          />
                          Fastest lap
                        </label>
                      </div>

                      <label className="block text-gray-500 text-[10px] uppercase">
                        Points
                        <input
                          type="number"
                          inputMode="numeric"
                          value={fPoints}
                          onChange={(e) => setFPoints(e.target.value)}
                          placeholder={`Auto: ${autoPoints}`}
                          className={INPUT}
                        />
                      </label>

                      <div className="flex gap-2">
                        <button
                          onClick={saveResult}
                          disabled={saving}
                          className="flex-1 rounded-lg bg-[#E8284A] py-2 text-xs font-bold text-white disabled:opacity-40"
                        >
                          {saving ? 'Saving…' : 'Save result'}
                        </button>
                        <button
                          onClick={() => setShowForm(false)}
                          className="flex-1 rounded-lg border border-gray-800 py-2 text-xs font-semibold text-gray-400"
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {scoped.length > 0 && (
                  <div>
                    <SectionHeader title="Results" count={scoped.length} />
                    <div className="space-y-2">
                      {scoped.map((r) => (
                        <div
                          key={r.id}
                          className="rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-white text-xs font-semibold truncate">
                              {seriesLabel(r.series)} S{r.season} R{r.round}
                              {r.race_type === 'sprint' ? ' · Sprint' : ''}
                              {r.track_name ? ` · ${r.track_name}` : ''}
                            </p>
                            <p className="text-gray-500 text-[11px]">
                              {r.quali_position !== null ? `Q${r.quali_position}` : 'Q—'}
                              {' → '}
                              {r.dnf ? 'DNF' : r.finish_position !== null ? `P${r.finish_position}` : '—'}
                              {r.fastest_lap ? ' · FL' : ''}
                              {r.team_name ? ` · ${r.team_name}` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-white text-xs font-mono">{r.points} pts</span>
                            <button
                              onClick={() => deleteResult(r)}
                              className="text-gray-600 text-lg leading-none"
                              aria-label="Delete result"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
