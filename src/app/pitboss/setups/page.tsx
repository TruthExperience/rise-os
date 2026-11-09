'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { SetupFeedbackPanel } from '@/components/setups/SetupFeedbackPanel'
import { SubmitSetupForm } from '@/components/setups/SubmitSetupForm'

interface CarClass {
  id: string
  code: string
  display_name: string
  category: string
  season: string
}

interface Track {
  id: string
  slug: string
  name: string
  country: string | null
  archetype: string | null
}

interface CarDriver {
  id: string
  team_id: string
  driver_name: string
  car_number: string | null
}

interface CarTeam {
  id: string
  team_name: string
  short_name: string | null
  logo_url: string | null
  drivers: CarDriver[]
}

interface CareerDriver {
  id: string
  driver_name: string
  pace: number
  racecraft: number
  awareness: number
  experience: number
  focus: number
  overall: number
}


interface Rationale {
  value: number
  unit: string
  origin: string
  override_applied: boolean
  contributors: { submission_id: string; source_name: string | null; value: number; weight: number }[]
  adjustment?: { delta: number; reason: string; clamped: boolean }
}

interface Recommendation {
  id: string
  generated_setup: Record<string, number>
  rationale: Record<string, Rationale>
  confidence: number
  baseline_used: boolean
  model: string
  created_at: string
}

const CONDITIONS = ['dry', 'wet', 'mixed'] as const
const SESSION_TYPES = ['race', 'qualifying', 'sprint', 'time_trial', 'practice'] as const
const DRIVER_MODES = ['league', 'career'] as const

const CAREER_STAT_KEYS = ['pace', 'racecraft', 'awareness', 'experience', 'focus'] as const
type CareerStatKey = typeof CAREER_STAT_KEYS[number]
type CareerStats = Record<CareerStatKey, number>

// Mirrors computeOverall in the career-drivers API routes (live preview only —
// the server recomputes and stores the real overall on save).
function previewOverall(s: CareerStats): number {
  return Math.round(
    s.pace * 0.35 + s.racecraft * 0.2 + s.awareness * 0.2 + s.experience * 0.15 + s.focus * 0.1
  )
}

interface StatSnapshot extends CareerStats {
  id: string
  overall: number
  recorded_at: string
}

function ProgressChart({ history }: { history: StatSnapshot[] }) {
  if (history.length < 2) {
    return (
      <p className="text-gray-500 text-xs">
        Save an update after your next race or season to start tracking progress.
      </p>
    )
  }
  const W = 300
  const H = 70
  const PAD = 6
  const vals = history.map((h) => h.overall)
  const min = Math.min(...vals) - 1
  const max = Math.max(...vals) + 1
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (history.length - 1)
  const y = (v: number) => H - PAD - ((v - min) * (H - PAD * 2)) / (max - min)
  const points = history.map((h, i) => `${x(i)},${y(h.overall)}`).join(' ')
  const first = history[0]
  const last = history[history.length - 1]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-gray-400 text-xs uppercase tracking-wide">OVR progress</span>
        <span className="text-white text-xs font-mono">
          {first.overall} → {last.overall}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16">
        <polyline points={points} fill="none" stroke="#E8284A" strokeWidth={2} />
        {history.map((h, i) => (
          <circle key={h.id} cx={x(i)} cy={y(h.overall)} r={2.5} fill="#E8284A" />
        ))}
      </svg>
      <div className="grid grid-cols-5 gap-1 text-center">
        {CAREER_STAT_KEYS.map((k) => {
          const diff = last[k] - first[k]
          return (
            <div key={k}>
              <p className="text-gray-500 text-[10px] uppercase">{k.slice(0, 4)}</p>
              <p className="text-white text-xs font-mono">{last[k]}</p>
              <p
                className={`text-[10px] font-mono ${
                  diff > 0 ? 'text-green-400' : diff < 0 ? 'text-red-400' : 'text-gray-600'
                }`}
              >
                {diff > 0 ? '+' : ''}{diff}
              </p>
            </div>
          )
        })}
      </div>
      <p className="text-gray-600 text-[10px]">
        {history.length} updates since {new Date(first.recorded_at).toLocaleDateString()}
      </p>
    </div>
  )
}

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

function StatSlider({
  label,
  value,
  onChange,
  saved,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  saved?: number
}) {
  const diff = saved !== undefined ? value - saved : 0
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-400 text-xs uppercase tracking-wide">{label}</span>
        <span className="text-white text-xs font-mono">
          {value}
          {diff !== 0 && (
            <span className={diff > 0 ? 'text-green-400' : 'text-red-400'}>
              {' '}({diff > 0 ? '+' : ''}{diff})
            </span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={99}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#E8284A]"
      />
    </div>
  )
}

export default function SetupsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [carClasses, setCarClasses] = useState<CarClass[]>([])
  const [tracks, setTracks]         = useState<Track[]>([])
  const [loadingOptions, setLoadingOptions] = useState(true)

  const [carClassId, setCarClassId]   = useState('')
  const [trackId, setTrackId]         = useState('')
  const [conditions, setConditions]   = useState<typeof CONDITIONS[number]>('dry')
  const [sessionType, setSessionType] = useState<typeof SESSION_TYPES[number]>('race')

  // Team picker — independent of driver mode. Team traits nudge the setup
  // regardless of whether the driver is a League Driver or Career Mode Driver.
  const [teams, setTeams]                 = useState<CarTeam[]>([])
  const [loadingTeams, setLoadingTeams]     = useState(false)
  const [teamId, setTeamId]                 = useState('')

  // Driver mode: League Driver (existing roster picker) vs Career Mode
  // Driver (Pace/Racecraft/Awareness/Experience stat input).
  const [driverMode, setDriverMode] = useState<typeof DRIVER_MODES[number]>('league')

  // League Driver state
  const [driverId, setDriverId]             = useState('')
  const [driverFreetext, setDriverFreetext] = useState('')

  // Career Mode Driver state
  const [careerDrivers, setCareerDrivers]         = useState<CareerDriver[]>([])
  const [loadingCareerDrivers, setLoadingCareerDrivers] = useState(false)
  const [careerDriverId, setCareerDriverId]       = useState('')
  const [creatingCareerDriver, setCreatingCareerDriver] = useState(false)
  const [newCareerDriverName, setNewCareerDriverName]   = useState('')
    const [newPace, setNewPace]             = useState(70)
  const [newRacecraft, setNewRacecraft]   = useState(70)
  const [newAwareness, setNewAwareness]   = useState(70)
  const [newExperience, setNewExperience] = useState(70)
  const [newFocus, setNewFocus]           = useState(70)
  const [savingCareerDriver, setSavingCareerDriver] = useState(false)

  // Editable copy of the selected career driver's attributes, so the user can
  // update the sliders as the career progresses and save them back.
  const [editStats, setEditStats]           = useState<CareerStats | null>(null)
  const [savingStats, setSavingStats]       = useState(false)
  const [statsSaved, setStatsSaved]         = useState(false)
  const [statHistory, setStatHistory]       = useState<StatSnapshot[]>([])


  const [generating, setGenerating]   = useState(false)
  const [error, setError]             = useState('')
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    loadOptions()
  }, [])

  // Reload teams whenever the car class changes, and reset any picked
  // team/driver since they belong to the previous car class's roster.
  useEffect(() => {
    setTeamId('')
    setDriverId('')
    setDriverFreetext('')
    setTeams([])
    if (!carClassId) return

    setLoadingTeams(true)
    fetch(`/api/pitboss/setups/teams?car_class_id=${carClassId}`)
      .then((res) => res.json())
      .then((data) => setTeams(data.teams ?? []))
      .catch(() => setTeams([]))
      .finally(() => setLoadingTeams(false))
  }, [carClassId])

  // Load career mode drivers once, when the mode is first switched to career.
  useEffect(() => {
    if (driverMode !== 'career' || careerDrivers.length > 0) return
    setLoadingCareerDrivers(true)
    fetch('/api/pitboss/setups/career-drivers')
      .then((res) => res.json())
      .then((data) => setCareerDrivers(data.career_drivers ?? []))
      .catch(() => setCareerDrivers([]))
      .finally(() => setLoadingCareerDrivers(false))
  }, [driverMode, careerDrivers.length])

  // Whenever a career driver is picked, load its saved attributes into the
  // editable sliders.
  useEffect(() => {
    const d = careerDrivers.find((c) => c.id === careerDriverId)
    setStatsSaved(false)
    setEditStats(
      d
        ? { pace: d.pace, racecraft: d.racecraft, awareness: d.awareness, experience: d.experience, focus: d.focus }
        : null
    )
  }, [careerDriverId, careerDrivers])

  async function loadStatHistory(id: string) {
    try {
      const res = await fetch(`/api/pitboss/setups/career-drivers/${id}/history`)
      const data = await res.json()
      setStatHistory(res.ok ? (data.history ?? []) : [])
    } catch {
      setStatHistory([])
    }
  }

  // Load the progress history whenever a different career driver is picked.
  useEffect(() => {
    setStatHistory([])
    if (careerDriverId) loadStatHistory(careerDriverId)
  }, [careerDriverId])

  async function loadOptions() {
    setLoadingOptions(true)
    try {
      const res = await fetch('/api/pitboss/setups/options')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load options')
      setCarClasses(data.car_classes)
      setTracks(data.tracks)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoadingOptions(false)
    }
  }

  function switchDriverMode(mode: typeof DRIVER_MODES[number]) {
    setDriverMode(mode)
    // Clear the other mode's selection so a stale id can't get sent alongside it.
    if (mode === 'league') {
      setCareerDriverId('')
      setCreatingCareerDriver(false)
    } else {
      setDriverId('')
      setDriverFreetext('')
    }
  }

  async function saveNewCareerDriver() {
    if (!newCareerDriverName.trim()) {
      setError('Enter a driver name before saving.')
      return
    }
    setSavingCareerDriver(true)
    setError('')
    try {
      const res = await fetch('/api/pitboss/setups/career-drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
          driver_name: newCareerDriverName.trim(),
          pace: newPace,
          racecraft: newRacecraft,
          awareness: newAwareness,
          experience: newExperience,
          focus: newFocus,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save career driver')
      setCareerDrivers((prev) => [...prev, data])
      setCareerDriverId(data.id)
      setCreatingCareerDriver(false)
      setNewCareerDriverName('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingCareerDriver(false)
    }
  }

  async function saveCareerStats() {
    if (!careerDriverId || !editStats) return
    setSavingStats(true)
    setError('')
    setStatsSaved(false)
    try {
      const res = await fetch(`/api/pitboss/setups/career-drivers/${careerDriverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editStats),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to update career driver')
      setCareerDrivers((prev) =>
        prev.map((c) =>
          c.id === careerDriverId
            ? {
                ...c,
                pace: data.pace,
                racecraft: data.racecraft,
                awareness: data.awareness,
                experience: data.experience,
                focus: data.focus,
                overall: data.overall,
              }
            : c
        )
      )
      setStatsSaved(true)
      loadStatHistory(careerDriverId)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingStats(false)
    }
  }

  async function generateRecommendation() {
    if (!carClassId || !trackId) return
    setGenerating(true)
    setError('')
    setRecommendation(null)

    try {
      // Driver identity is now resolved server-side from the authenticated
      // session (see getAuthedDriver in lib/pitbossAuth.ts) — discord_id is
      // no longer sent from the client, since a client-supplied value could
      // be spoofed to attribute the recommendation to an arbitrary driver.
      const res = await fetch('/api/pitboss/setups/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          car_class_id: carClassId,
          track_id:     trackId,
          conditions,
          session_type: sessionType,
          car_team_id: teamId || null,
          car_driver_id: driverMode === 'league' ? (driverId || null) : null,
          car_driver_name_freetext:
            driverMode === 'league' && !driverId ? (driverFreetext.trim() || null) : null,
          career_driver_id: driverMode === 'career' ? (careerDriverId || null) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate recommendation')
      setRecommendation(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  function handleAdjusted(newRecommendationId: string, adjustedSetup: Record<string, number>) {
    if (!recommendation) return
    setRecommendation({
      ...recommendation,
      id: newRecommendationId,
      generated_setup: adjustedSetup,
    })
  }

  if (status === 'loading' || loadingOptions) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading…</p>
      </div>
    )
  }

  const selectedTrack = tracks.find((t) => t.id === trackId)
  const selectedTeam = teams.find((t) => t.id === teamId)
  const selectedTeamDrivers = selectedTeam?.drivers ?? []
  const selectedCareerDriver = careerDrivers.find((c) => c.id === careerDriverId)
  const statsDirty =
    !!selectedCareerDriver &&
    !!editStats &&
    CAREER_STAT_KEYS.some((k) => editStats[k] !== selectedCareerDriver[k])

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">
      <div className="px-4 pt-8 pb-4">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-4">
          ← Back
        </button>
        <h1 className="text-white font-black text-2xl">Setup Generator</h1>
        <p className="text-gray-500 text-sm mt-1">Community-weighted baseline, tuned by your feedback.</p>
      </div>

            <div className="px-4 space-y-6">
        <button
          onClick={() => router.push('/pitboss/setups/driver-style-profile')}
          className="w-full rounded-xl border border-gray-800 bg-gray-900 px-4 py-3 text-left flex items-center justify-between"
        >
          <div>
            <p className="text-white text-sm font-semibold">Driving Style</p>
            <p className="text-gray-500 text-xs mt-0.5">Car feel, race length, and assists — tunes every generated setup</p>
          </div>
          <span className="text-[#E8284A] text-lg">→</span>
        </button>

        <button
          onClick={() => router.push('/pitboss/setups/telemetry-upload')}
          className="w-full rounded-xl border border-gray-800 bg-gray-900 px-4 py-3 text-left flex items-center justify-between"
        >
          <div>
            <p className="text-white text-sm font-semibold">Telemetry Upload</p>
            <p className="text-gray-500 text-xs mt-0.5">Upload session data to sharpen community setup recommendations</p>
          </div>
          <span className="text-[#E8284A] text-lg">→</span>
        </button>

        <div>
          <SectionHeader title="Car Class" />

          <div className="grid grid-cols-2 gap-2">
            {carClasses.map((cc) => (
              <button
                key={cc.id}
                onClick={() => setCarClassId(cc.id)}
                className={`rounded-xl px-4 py-3 text-left border transition-colors ${
                  carClassId === cc.id
                    ? 'border-[#E8284A] bg-[#E8284A]/10'
                    : 'border-gray-800 bg-gray-900'
                }`}
              >
                <p className="text-white text-sm font-semibold">{cc.display_name}</p>
                <p className="text-gray-500 text-xs">{cc.season}</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <SectionHeader title="Track" />
          <select
            value={trackId}
            onChange={(e) => setTrackId(e.target.value)}
            className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
          >
            <option value="">Select a track…</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.country ? ` — ${t.country}` : ''}
              </option>
            ))}
          </select>
          {selectedTrack?.archetype && (
            <p className="text-gray-500 text-xs mt-1.5 capitalize">{selectedTrack.archetype.replace(/_/g, ' ')}</p>
          )}
        </div>

        <div>
          <SectionHeader title="Team" />
          {!carClassId ? (
            <p className="text-gray-500 text-xs">Select a car class to see teams.</p>
          ) : loadingTeams ? (
            <p className="text-gray-500 text-xs">Loading teams…</p>
          ) : teams.length === 0 ? (
            <p className="text-gray-500 text-xs">No teams found for this car class.</p>
          ) : (
            <select
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value)
                setDriverId('')
                setDriverFreetext('')
              }}
              className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
            >
              <option value="">Select a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.team_name}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <SectionHeader title="Driver" />

          <div className="flex gap-2 mb-3">
            {DRIVER_MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => switchDriverMode(mode)}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold border transition-colors ${
                  driverMode === mode
                    ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                    : 'border-gray-800 bg-gray-900 text-gray-500'
                }`}
              >
                {mode === 'league' ? 'League Driver' : 'Career Mode Driver'}
              </button>
            ))}
          </div>

          {driverMode === 'league' && (
            teamId ? (
              selectedTeamDrivers.length > 0 ? (
                <select
                  value={driverId}
                  onChange={(e) => setDriverId(e.target.value)}
                  className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
                >
                  <option value="">Select a driver…</option>
                  {selectedTeamDrivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.driver_name}{d.car_number ? ` (#${d.car_number})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={driverFreetext}
                  onChange={(e) => setDriverFreetext(e.target.value)}
                  placeholder="Driver name (no roster on file for this team)"
                  className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#E8284A]"
                />
              )
            ) : (
              <p className="text-gray-500 text-xs">Select a team to see its drivers.</p>
            )
          )}

          {driverMode === 'career' && (
            <div className="space-y-3">
              {loadingCareerDrivers ? (
                <p className="text-gray-500 text-xs">Loading career drivers…</p>
              ) : (
                <select
                  value={careerDriverId}
                  onChange={(e) => setCareerDriverId(e.target.value)}
                  className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
                >
                  <option value="">Select a career mode driver…</option>
                  {careerDrivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.driver_name} — {d.overall} OVR
                    </option>
                  ))}
                </select>
              )}

              {selectedCareerDriver && editStats && (
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-white text-sm font-semibold">Career attributes</p>
                    <p className="text-xs font-mono text-gray-400">
                      OVR {previewOverall(editStats)}
                      {previewOverall(editStats) !== selectedCareerDriver.overall && (
                        <span
                          className={
                            previewOverall(editStats) > selectedCareerDriver.overall
                              ? 'text-green-400'
                              : 'text-red-400'
                          }
                        >
                          {' '}({previewOverall(editStats) > selectedCareerDriver.overall ? '+' : ''}
                          {previewOverall(editStats) - selectedCareerDriver.overall})
                        </span>
                      )}
                    </p>
                  </div>
                  {CAREER_STAT_KEYS.map((k) => (
                    <StatSlider
                      key={k}
                      label={k.charAt(0).toUpperCase() + k.slice(1)}
                      value={editStats[k]}
                      saved={selectedCareerDriver[k]}
                      onChange={(v) => {
                        setStatsSaved(false)
                        setEditStats((prev) => (prev ? { ...prev, [k]: v } : prev))
                      }}
                    />
                  ))}
                  <p className="text-gray-500 text-xs">
                    Update these as your career progresses. Saved values feed straight into your setup recommendation.
                  </p>
                  <div className="border-t border-gray-800 pt-3">
                    <ProgressChart history={statHistory} />
                  </div>
                  <button
                    onClick={() => router.push(`/pitboss/career?driver=${selectedCareerDriver.id}`)}
                    className="w-full rounded-lg border border-gray-800 py-2 text-xs font-semibold text-[#E8284A]"
                  >
                    Career tracker: qualifying &amp; race results →
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={saveCareerStats}
                      disabled={!statsDirty || savingStats}
                      className="flex-1 rounded-lg bg-[#E8284A] py-2 text-xs font-bold text-white disabled:opacity-40"
                    >
                      {savingStats ? 'Saving…' : statsSaved && !statsDirty ? 'Saved ✓' : 'Save progress'}
                    </button>
                    <button
                      onClick={() =>
                        setEditStats({
                          pace: selectedCareerDriver.pace,
                          racecraft: selectedCareerDriver.racecraft,
                          awareness: selectedCareerDriver.awareness,
                          experience: selectedCareerDriver.experience,
                          focus: selectedCareerDriver.focus,
                        })
                      }
                      disabled={!statsDirty || savingStats}
                      className="flex-1 rounded-lg border border-gray-800 py-2 text-xs font-semibold text-gray-400 disabled:opacity-40"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}

              {!creatingCareerDriver ? (
                <button
                  onClick={() => setCreatingCareerDriver(true)}
                  className="text-[#E8284A] text-xs font-semibold"
                >
                  + New career mode driver
                </button>
              ) : (
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
                  <input
                    value={newCareerDriverName}
                    onChange={(e) => setNewCareerDriverName(e.target.value)}
                    placeholder="Driver name"
                    className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#E8284A]"
                  />
                                    <StatSlider label="Pace" value={newPace} onChange={setNewPace} />
                  <StatSlider label="Racecraft" value={newRacecraft} onChange={setNewRacecraft} />
                  <StatSlider label="Awareness" value={newAwareness} onChange={setNewAwareness} />
                  <StatSlider label="Experience" value={newExperience} onChange={setNewExperience} />
                  <StatSlider label="Focus" value={newFocus} onChange={setNewFocus} />

                  <div className="flex gap-2">
                    <button
                      onClick={saveNewCareerDriver}
                      disabled={savingCareerDriver}
                      className="flex-1 rounded-lg bg-[#E8284A] py-2 text-xs font-bold text-white disabled:opacity-40"
                    >
                      {savingCareerDriver ? 'Saving…' : 'Save & Use'}
                    </button>
                    <button
                      onClick={() => setCreatingCareerDriver(false)}
                      className="flex-1 rounded-lg border border-gray-800 py-2 text-xs font-semibold text-gray-400"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <SectionHeader title="Conditions" />
            <div className="flex gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setConditions(c)}
                  className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold capitalize border transition-colors ${
                    conditions === c
                      ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                      : 'border-gray-800 bg-gray-900 text-gray-500'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <SectionHeader title="Session" />
            <select
              value={sessionType}
              onChange={(e) => setSessionType(e.target.value as typeof SESSION_TYPES[number])}
              className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-white text-xs focus:outline-none focus:border-[#E8284A]"
            >
              {SESSION_TYPES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={generateRecommendation}
          disabled={!carClassId || !trackId || generating}
          className="w-full rounded-xl bg-[#E8284A] py-3 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {generating ? 'Generating…' : 'Generate Setup'}
        </button>

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {carClassId && trackId && (
          <SubmitSetupForm
            carClassId={carClassId}
            trackId={trackId}
            conditions={conditions}
            sessionType={sessionType}
            discordId={session?.user?.discordId}
          />
        )}

        {recommendation && (
          <>
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionHeader title="Generated Setup" />
                <div className="text-right">
                  <p className="text-xs text-gray-500">
                    {recommendation.baseline_used ? 'Class default' : `${Math.round(recommendation.confidence * 100)}% confidence`}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(recommendation.generated_setup).map(([key, value], i) => (
                      <tr key={key} className={i > 0 ? 'border-t border-gray-800' : ''}>
                        <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{key}</td>
                        <td className="px-4 py-2.5 text-right text-white font-mono text-xs">
                          {value}
                          {recommendation.rationale[key]?.unit && (
                            <span className="text-gray-600 ml-1">{recommendation.rationale[key].unit}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <SetupFeedbackPanel
              recommendationId={recommendation.id}
              currentSetup={recommendation.generated_setup}
              discordId={session?.user?.discordId}
              onAdjusted={handleAdjusted}
            />
          </>
        )}
      </div>
    </div>
  )
}
