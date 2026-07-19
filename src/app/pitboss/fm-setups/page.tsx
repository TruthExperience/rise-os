'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────

type FmSetupParamKey = 'front_wing_angle' | 'rear_wing_angle' | 'anti_roll_bar' | 'tyre_camber' | 'toe_out'
type FmBiasKey = 'oversteer' | 'braking' | 'cornering' | 'traction' | 'straights'
type FmFeedbackValue = 'optimal' | 'great' | 'good' | 'bad' | 'bad+' | 'bad-' | 'unknown'

interface Track {
  id: string
  name: string
  slug: string
  country: string | null
}

interface ParamDef {
  param_key: FmSetupParamKey
  label: string
  characteristic: string
  min_value: number
  max_value: number
  step: number
  unit: string
  value_format: string
  display_order: number
}

interface CalculateResponse {
  session_id: string
  iteration_count: number
  lowest_rule_break: number
  possible_setups: number
  best_setup: Record<FmSetupParamKey, number> | null
  candidates: { setup: Record<FmSetupParamKey, number>; diff: number }[]
  current_feedback: Record<FmBiasKey, { value: number; feedback: FmFeedbackValue }[]>
}

const FM_BIAS_ORDER: FmBiasKey[] = ['oversteer', 'braking', 'cornering', 'traction', 'straights']
const FEEDBACK_OPTIONS: FmFeedbackValue[] = ['optimal', 'great', 'good', 'bad', 'bad+', 'bad-']

const FEEDBACK_LABELS: Record<FmFeedbackValue, string> = {
  optimal: 'Optimal',
  great: 'Great',
  good: 'Good',
  bad: 'Bad',
  'bad+': 'Bad+',
  'bad-': 'Bad-',
  unknown: 'Unknown',
}

const BIAS_LABELS: Record<FmBiasKey, string> = {
  oversteer: 'Oversteer',
  braking: 'Braking',
  cornering: 'Cornering',
  traction: 'Traction',
  straights: 'Straights',
}

// Rounds away JS floating-point drift (e.g. 3.1500000000000004) that appears
// when a slider's step (like 0.05) is repeatedly added via Number(e.target.value).
function roundToStep(v: number, step: number) {
  const decimals = (step.toString().split('.')[1] || '').length
  return Number(v.toFixed(decimals))
}

function formatValue(v: number, p: ParamDef) {
  const rounded = roundToStep(v, p.step)
  if (p.value_format === 'ratio_out_of_10') return `${rounded}:${10 - rounded}`
  return `${rounded}${p.unit}`
}

// ─── Per-driver lane state ──────────────────────────────────────────────

interface LaneState {
  slot: 1 | 2
  driverName: string
  started: boolean
  calculating: boolean
  error: string
  result: CalculateResponse | null
  currentValues: Record<FmSetupParamKey, number> | null
  feedbackSelections: Partial<Record<FmBiasKey, FmFeedbackValue>>
  expanded: boolean
}

function emptyLane(slot: 1 | 2): LaneState {
  return {
    slot,
    driverName: '',
    started: false,
    calculating: false,
    error: '',
    result: null,
    currentValues: null,
    feedbackSelections: {},
    expanded: true,
  }
}

export default function FmSetupsPage() {
  const { data: session, status: authStatus } = useSession()
  const router = useRouter()

  const [loadingMeta, setLoadingMeta] = useState(true)
  const [metaError, setMetaError] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [params, setParams] = useState<ParamDef[]>([])

  // Shared session config — both drivers are setting up for the same event
  const [circuitId, setCircuitId] = useState('')
  const [conditions, setConditions] = useState<'dry' | 'wet'>('dry')
  const [sessionStarted, setSessionStarted] = useState(false)

  // Two independent lanes, one per driver, running in parallel
  const [lanes, setLanes] = useState<[LaneState, LaneState]>([emptyLane(1), emptyLane(2)])

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/login')
  }, [authStatus, router])

  useEffect(() => {
    loadMeta()
  }, [])

  async function loadMeta() {
    setLoadingMeta(true)
    try {
      const res = await fetch('/api/pitboss/fm/setups/meta')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load setup data')
      setTracks(data.tracks ?? [])
      setParams(data.params ?? [])
    } catch (err: any) {
      setMetaError(err.message)
    } finally {
      setLoadingMeta(false)
    }
  }

  function discordId() {
    return (session?.user as any)?.discordId ?? null
  }

  function updateLane(idx: 0 | 1, patch: Partial<LaneState>) {
    setLanes((prev) => {
      const next = [...prev] as [LaneState, LaneState]
      next[idx] = { ...next[idx], ...patch }
      return next
    })
  }

  async function runCalculate(idx: 0 | 1, body: Record<string, any>) {
    const lane = lanes[idx]
    updateLane(idx, { calculating: true, error: '' })
    try {
      const res = await fetch('/api/pitboss/fm/setups/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuit_id: circuitId,
          conditions,
          driver_slot: lane.slot,
          driver_slot_name: lane.driverName || null,
          discord_id: discordId(),
          ...body,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Calculation failed')

      let rounded: Record<FmSetupParamKey, number> | null = null
      if (data.best_setup) {
        rounded = Object.fromEntries(
          params.map((p) => [p.param_key, roundToStep(data.best_setup[p.param_key], p.step)])
        ) as Record<FmSetupParamKey, number>
      }
      updateLane(idx, {
        result: data,
        currentValues: rounded,
        feedbackSelections: {},
      })
      return data as CalculateResponse
    } catch (err: any) {
      updateLane(idx, { error: err.message })
      return null
    } finally {
      updateLane(idx, { calculating: false })
    }
  }

  async function handleStartSession() {
    if (!circuitId) {
      updateLane(0, { error: 'Select a track first' })
      return
    }
    setSessionStarted(true)
    setLanes([{ ...lanes[0], started: true }, { ...lanes[1], started: true }])
    await Promise.all([runCalculate(0, {}), runCalculate(1, {})])
  }

  async function handleSubmitFeedback(idx: 0 | 1) {
    const lane = lanes[idx]
    if (!lane.currentValues) return
    const newFeedback = Object.fromEntries(
      Object.entries(lane.feedbackSelections).filter(([, v]) => !!v)
    )
    if (Object.keys(newFeedback).length === 0) {
      updateLane(idx, { error: 'Select at least one feedback rating before submitting' })
      return
    }
    await runCalculate(idx, { current_values: lane.currentValues, new_feedback: newFeedback })
  }

  function updateCurrentValue(idx: 0 | 1, key: FmSetupParamKey, value: number) {
    const paramDef = params.find((p) => p.param_key === key)
    const clean = paramDef ? roundToStep(value, paramDef.step) : value
    const lane = lanes[idx]
    updateLane(idx, {
      currentValues: { ...(lane.currentValues ?? ({} as Record<FmSetupParamKey, number>)), [key]: clean },
    })
  }

  function resetSession() {
    setSessionStarted(false)
    setLanes([emptyLane(1), emptyLane(2)])
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (authStatus === 'loading' || loadingMeta) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button onClick={() => router.back()} className="text-white/40 text-sm mb-4 block">← Back</button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">FM Setup Generator</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          F1 Manager setup solver · both drivers
        </p>
      </div>

      {metaError && (
        <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3 mb-4">
          <p className="text-red-400 text-sm">{metaError}</p>
        </div>
      )}

      {/* ── Shared session config ──────────────────────────────────────── */}
      {!sessionStarted && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Track</p>
            <select
              value={circuitId}
              onChange={(e) => setCircuitId(e.target.value)}
              className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:border-rise-red"
            >
              <option value="">Select a track…</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.country ? ` (${t.country})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Conditions</p>
            <div className="flex gap-2">
              {(['dry', 'wet'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setConditions(c)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-bold uppercase tracking-widest ${
                    conditions === c ? 'bg-rise-red text-white' : 'bg-white/5 text-white/40 border border-white/10'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {([0, 1] as const).map((idx) => (
              <div key={idx}>
                <p className="text-white/40 text-xs uppercase tracking-widest mb-2">
                  Driver {lanes[idx].slot} Name (optional)
                </p>
                <input
                  value={lanes[idx].driverName}
                  onChange={(e) => updateLane(idx, { driverName: e.target.value })}
                  placeholder="in-game driver name"
                  className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:border-rise-red placeholder-white/20"
                />
              </div>
            ))}
          </div>

          {lanes[0].error && <p className="text-red-400 text-xs">{lanes[0].error}</p>}

          <button
            onClick={handleStartSession}
            disabled={lanes[0].calculating || lanes[1].calculating || !circuitId}
            className="w-full bg-rise-red disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
          >
            {lanes[0].calculating || lanes[1].calculating ? 'Starting…' : 'Start Session — Both Drivers'}
          </button>
        </div>
      )}

      {/* ── Two parallel driver lanes ──────────────────────────────────── */}
      {sessionStarted && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-white font-bold text-sm">
                {tracks.find((t) => t.id === circuitId)?.name} · {conditions}
              </p>
              <button onClick={resetSession} className="text-white/30 text-xs underline">
                Change
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {([0, 1] as const).map((idx) => {
              const lane = lanes[idx]
              return (
                <div key={idx} className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
                  <button
                    onClick={() => updateLane(idx, { expanded: !lane.expanded })}
                    className="w-full flex items-center justify-between"
                  >
                    <div className="text-left">
                      <p className="text-white font-bold text-sm">
                        Driver {lane.slot}{lane.driverName ? ` · ${lane.driverName}` : ''}
                      </p>
                      {!lane.expanded && lane.result?.best_setup && (
                        <p className="text-white/40 text-[11px] mt-0.5">
                          FW {formatValue(lane.result.best_setup.front_wing_angle, params.find((p) => p.param_key === 'front_wing_angle')!)}
                          {' · '}
                          RW {formatValue(lane.result.best_setup.rear_wing_angle, params.find((p) => p.param_key === 'rear_wing_angle')!)}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {lane.result && (
                        <p className="text-white/30 text-[11px]">
                          Iter {lane.result.iteration_count} · {lane.result.possible_setups} match
                          {lane.result.lowest_rule_break > 0 ? ` (${lane.result.lowest_rule_break} break${lane.result.lowest_rule_break === 1 ? '' : 's'})` : ''}
                        </p>
                      )}
                      <span className={`text-white/40 text-xs transition-transform ${lane.expanded ? 'rotate-180' : ''}`}>
                        ▾
                      </span>
                    </div>
                  </button>

                  {lane.expanded && lane.error && (
                    <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3">
                      <p className="text-red-400 text-sm">{lane.error}</p>
                    </div>
                  )}

                  {lane.expanded && lane.result?.best_setup && (
                    <div className="rounded-2xl border border-rise-red/30 bg-rise-red/5 p-4">
                      <p className="text-white/40 text-xs uppercase tracking-widest mb-3">Recommended Setup</p>
                      <div className="grid grid-cols-2 gap-3">
                        {params.map((p) => (
                          <div key={p.param_key}>
                            <p className="text-white/30 text-[10px] uppercase tracking-widest">{p.label}</p>
                            <p className="text-white font-bold text-base">
                              {formatValue(lane.result!.best_setup![p.param_key], p)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {lane.expanded && lane.currentValues && (() => {
                    const currentValues = lane.currentValues!
                    return (
                    <div className="space-y-4 pt-2">
                      <p className="text-white/70 font-bold text-xs">Report Back From The Sim</p>
                      <div className="space-y-3">
                        {params.map((p) => (
                          <div key={p.param_key}>
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-white/40 text-xs uppercase tracking-widest">{p.label}</p>
                              <p className="text-white text-xs font-bold">
                                {formatValue(currentValues[p.param_key], p)}
                              </p>
                            </div>
                            <input
                              type="range"
                              min={p.min_value}
                              max={p.max_value}
                              step={p.step}
                              value={currentValues[p.param_key]}
                              onChange={(e) => updateCurrentValue(idx, p.param_key, Number(e.target.value))}
                              className="w-full accent-rise-red"
                            />
                          </div>
                        ))}
                      </div>

                      <div className="space-y-3 pt-2 border-t border-white/10">
                        {FM_BIAS_ORDER.map((biasKey) => (
                          <div key={biasKey}>
                            <p className="text-white/40 text-xs uppercase tracking-widest mb-2">{BIAS_LABELS[biasKey]}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {FEEDBACK_OPTIONS.map((fb) => (
                                <button
                                  key={fb}
                                  onClick={() =>
                                    updateLane(idx, {
                                      feedbackSelections: {
                                        ...lane.feedbackSelections,
                                        [biasKey]: lane.feedbackSelections[biasKey] === fb ? undefined : fb,
                                      },
                                    })
                                  }
                                  className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${
                                    lane.feedbackSelections[biasKey] === fb
                                      ? 'bg-rise-red text-white'
                                      : 'bg-white/5 text-white/40 border border-white/10'
                                  }`}
                                >
                                  {FEEDBACK_LABELS[fb]}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      <button
                        onClick={() => handleSubmitFeedback(idx)}
                        disabled={lane.calculating}
                        className="w-full bg-rise-red disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
                      >
                        {lane.calculating ? 'Recalculating…' : 'Submit Feedback & Recalculate'}
                      </button>
                    </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </main>
  )
}
