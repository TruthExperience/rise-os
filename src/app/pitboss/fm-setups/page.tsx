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

function formatValue(v: number, p: ParamDef) {
  if (p.value_format === 'ratio_out_of_10') return `${v}${p.unit}`
  return `${v}${p.unit}`
}

export default function FmSetupsPage() {
  const { data: session, status: authStatus } = useSession()
  const router = useRouter()

  const [loadingMeta, setLoadingMeta] = useState(true)
  const [metaError, setMetaError] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [params, setParams] = useState<ParamDef[]>([])

  // Session config
  const [circuitId, setCircuitId] = useState('')
  const [conditions, setConditions] = useState<'dry' | 'wet'>('dry')
  const [driverSlot, setDriverSlot] = useState<1 | 2>(1)
  const [driverSlotName, setDriverSlotName] = useState('')

  const [started, setStarted] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [calcError, setCalcError] = useState('')
  const [result, setResult] = useState<CalculateResponse | null>(null)

  // Feedback form — the setup the driver just tried in-game
  const [currentValues, setCurrentValues] = useState<Record<FmSetupParamKey, number> | null>(null)
  const [feedbackSelections, setFeedbackSelections] = useState<Partial<Record<FmBiasKey, FmFeedbackValue>>>({})

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

  async function runCalculate(body: Record<string, any>) {
    setCalculating(true)
    setCalcError('')
    try {
      const res = await fetch('/api/pitboss/fm/setups/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuit_id: circuitId,
          conditions,
          driver_slot: driverSlot,
          driver_slot_name: driverSlotName || null,
          discord_id: discordId(),
          ...body,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Calculation failed')
      setResult(data)
      if (data.best_setup) setCurrentValues(data.best_setup)
      setFeedbackSelections({})
      return data as CalculateResponse
    } catch (err: any) {
      setCalcError(err.message)
      return null
    } finally {
      setCalculating(false)
    }
  }

  async function handleStart() {
    if (!circuitId) {
      setCalcError('Select a track first')
      return
    }
    setStarted(true)
    await runCalculate({})
  }

  async function handleSubmitFeedback() {
    if (!currentValues) return
    const newFeedback = Object.fromEntries(
      Object.entries(feedbackSelections).filter(([, v]) => !!v)
    )
    if (Object.keys(newFeedback).length === 0) {
      setCalcError('Select at least one feedback rating before submitting')
      return
    }
    await runCalculate({ current_values: currentValues, new_feedback: newFeedback })
  }

  function updateCurrentValue(key: FmSetupParamKey, value: number) {
    setCurrentValues((prev) => ({ ...(prev ?? ({} as Record<FmSetupParamKey, number>)), [key]: value }))
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
          F1 Manager setup solver
        </p>
      </div>

      {metaError && (
        <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3 mb-4">
          <p className="text-red-400 text-sm">{metaError}</p>
        </div>
      )}

      {/* ── Session config ─────────────────────────────────────────────── */}
      {!started && (
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

          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Driver Slot</p>
            <div className="flex gap-2">
              {([1, 2] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setDriverSlot(s)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-bold ${
                    driverSlot === s ? 'bg-rise-red text-white' : 'bg-white/5 text-white/40 border border-white/10'
                  }`}
                >
                  Driver {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Driver Name (optional)</p>
            <input
              value={driverSlotName}
              onChange={(e) => setDriverSlotName(e.target.value)}
              placeholder="e.g. your in-game driver name"
              className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:outline-none focus:border-rise-red placeholder-white/20"
            />
          </div>

          {calcError && <p className="text-red-400 text-xs">{calcError}</p>}

          <button
            onClick={handleStart}
            disabled={calculating || !circuitId}
            className="w-full bg-rise-red disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
          >
            {calculating ? 'Starting…' : 'Start Session'}
          </button>
        </div>
      )}

      {/* ── Results + feedback loop ────────────────────────────────────── */}
      {started && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-white font-bold text-sm">
                {tracks.find((t) => t.id === circuitId)?.name} · {conditions} · Driver {driverSlot}
              </p>
              <button onClick={() => { setStarted(false); setResult(null) }} className="text-white/30 text-xs underline">
                Change
              </button>
            </div>
            {result && (
              <p className="text-white/30 text-xs">
                Iteration {result.iteration_count} · {result.possible_setups} setups match all feedback
                {result.lowest_rule_break > 0 ? ` (${result.lowest_rule_break} rule break${result.lowest_rule_break === 1 ? '' : 's'} tolerated)` : ''}
              </p>
            )}
          </div>

          {calcError && (
            <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm">{calcError}</p>
            </div>
          )}

          {result?.best_setup && (
            <div className="rounded-2xl border border-rise-red/30 bg-rise-red/5 p-4">
              <p className="text-white/40 text-xs uppercase tracking-widest mb-3">Recommended Setup</p>
              <div className="grid grid-cols-2 gap-3">
                {params.map((p) => (
                  <div key={p.param_key}>
                    <p className="text-white/30 text-[10px] uppercase tracking-widest">{p.label}</p>
                    <p className="text-white font-bold text-base">
                      {formatValue(result.best_setup![p.param_key], p)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Report the setup you tried + feedback ───────────────────── */}
          {currentValues && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
              <p className="text-white font-bold text-sm">Report Back From The Sim</p>
              <p className="text-white/30 text-xs -mt-2">
                Adjust to match the setup you actually ran, then rate each characteristic.
              </p>

              <div className="space-y-3">
                {params.map((p) => (
                  <div key={p.param_key}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-white/40 text-xs uppercase tracking-widest">{p.label}</p>
                      <p className="text-white text-xs font-bold">{formatValue(currentValues[p.param_key], p)}</p>
                    </div>
                    <input
                      type="range"
                      min={p.min_value}
                      max={p.max_value}
                      step={p.step}
                      value={currentValues[p.param_key]}
                      onChange={(e) => updateCurrentValue(p.param_key, Number(e.target.value))}
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
                            setFeedbackSelections((prev) => ({
                              ...prev,
                              [biasKey]: prev[biasKey] === fb ? undefined : fb,
                            }))
                          }
                          className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${
                            feedbackSelections[biasKey] === fb
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
                onClick={handleSubmitFeedback}
                disabled={calculating}
                className="w-full bg-rise-red disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
              >
                {calculating ? 'Recalculating…' : 'Submit Feedback & Recalculate'}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
