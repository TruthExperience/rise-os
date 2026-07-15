'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type CarFeel = 'loose_oversteer' | 'planted_understeer' | 'balanced' | 'aggressive_rotation' | 'stable_predictable'
type RaceLength = '5_lap' | '25_percent' | '35_percent' | '50_percent' | '100_percent'

const CAR_FEEL_OPTIONS: { value: CarFeel; label: string; blurb: string }[] = [
  { value: 'loose_oversteer', label: 'Loose / Oversteer', blurb: 'Rear rotates easily, I drive on the throttle' },
  { value: 'planted_understeer', label: 'Planted / Understeer', blurb: 'Stable front, I trust the car to hold a line' },
  { value: 'balanced', label: 'Balanced', blurb: 'No strong preference either way' },
  { value: 'aggressive_rotation', label: 'Aggressive Rotation', blurb: 'Maximum rotation, I like a knife-edge car' },
  { value: 'stable_predictable', label: 'Stable & Predictable', blurb: 'Minimize surprises, consistency over pace' },
]

const RACE_LENGTH_OPTIONS: { value: RaceLength; label: string }[] = [
  { value: '5_lap', label: '5 Lap' },
  { value: '25_percent', label: '25%' },
  { value: '35_percent', label: '35%' },
  { value: '50_percent', label: '50%' },
  { value: '100_percent', label: '100%' },
]

interface AssistsState {
  traction_control: 'off' | 'medium' | 'full'
  abs: 'off' | 'on'
  braking_assist: 'off' | 'on'
  steering_assist: 'off' | 'on'
  gearbox: 'manual' | 'manual_suggested' | 'automatic'
  dynamic_racing_line: 'off' | 'corners_only' | 'full'
  pit_assist: boolean
  ers_assist: boolean
  drs_assist: boolean
}

const DEFAULT_ASSISTS: AssistsState = {
  traction_control: 'medium',
  abs: 'on',
  braking_assist: 'off',
  steering_assist: 'off',
  gearbox: 'manual',
  dynamic_racing_line: 'off',
  pit_assist: false,
  ers_assist: false,
  drs_assist: false,
}

function SegmentedControl<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
            value === opt.value
              ? 'bg-[#E8284A] border-[#E8284A] text-white'
              : 'bg-gray-900 border-gray-800 text-gray-400'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export default function DriverStyleProfilePage() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')

  const [carFeelPreference, setCarFeelPreference] = useState<CarFeel>('balanced')
  const [preferredRaceLength, setPreferredRaceLength] = useState<RaceLength>('50_percent')
  const [carFeelNotes, setCarFeelNotes] = useState('')
  const [comparisonDrivers, setComparisonDrivers] = useState('')
  const [notes, setNotes] = useState('')
  const [assists, setAssists] = useState<AssistsState>(DEFAULT_ASSISTS)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const res = await fetch('/api/pitboss/setups/driver-style-profile')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load style profile')
        if (!cancelled && data.profile) {
          setCarFeelPreference(data.profile.car_feel_preference ?? 'balanced')
          setPreferredRaceLength(data.profile.preferred_race_length ?? '50_percent')
          setCarFeelNotes(data.profile.car_feel_notes ?? '')
          setComparisonDrivers(data.profile.comparison_drivers ?? '')
          setNotes(data.profile.notes ?? '')
          setAssists({ ...DEFAULT_ASSISTS, ...(data.profile.assists ?? {}) })
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function updateAssist<K extends keyof AssistsState>(key: K, value: AssistsState[K]) {
    setAssists((prev) => ({ ...prev, [key]: value }))
    setSavedMessage('')
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSavedMessage('')
    try {
      const res = await fetch('/api/pitboss/setups/driver-style-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          car_feel_preference: carFeelPreference,
          preferred_race_length: preferredRaceLength,
          car_feel_notes: carFeelNotes.trim() || null,
          comparison_drivers: comparisonDrivers.trim() || null,
          notes: notes.trim() || null,
          assists,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save style profile')
      setSavedMessage('Style profile saved. Future setup recommendations will use this.')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading style profile…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">
      <div className="px-4 pt-8">
        <button onClick={() => router.back()} className="text-gray-400 text-sm mb-4">← Back</button>
        <h1 className="text-white font-bold text-xl uppercase tracking-widest">Driving Style</h1>
        <p className="text-gray-500 text-sm mt-1">
          This tunes how generated setups lean — car feel, session length, and assists. Nothing here is graded.
        </p>
      </div>

      <div className="px-4 pt-6 space-y-6">

        <div className="bg-gray-900 rounded-xl p-4 space-y-3">
          <h2 className="text-white font-bold text-sm uppercase tracking-widest">Car Feel Preference</h2>
          <div className="space-y-2">
            {CAR_FEEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setCarFeelPreference(opt.value)}
                className={`w-full text-left rounded-lg px-3 py-2.5 border transition-colors ${
                  carFeelPreference === opt.value
                    ? 'bg-[#E8284A]/15 border-[#E8284A]'
                    : 'bg-black/30 border-gray-800'
                }`}
              >
                <p className="text-white text-sm font-semibold">{opt.label}</p>
                <p className="text-gray-500 text-xs mt-0.5">{opt.blurb}</p>
              </button>
            ))}
          </div>
          <textarea
            value={carFeelNotes}
            onChange={(e) => setCarFeelNotes(e.target.value)}
            placeholder="Optional notes on car feel (e.g. specific corners you struggle with)"
            rows={2}
            className="w-full rounded-lg bg-black/40 border border-gray-800 px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-[#E8284A] resize-none"
          />
        </div>

        <div className="bg-gray-900 rounded-xl p-4 space-y-3">
          <h2 className="text-white font-bold text-sm uppercase tracking-widest">Preferred Race Length</h2>
          <SegmentedControl options={RACE_LENGTH_OPTIONS} value={preferredRaceLength} onChange={setPreferredRaceLength} />
        </div>

        <div className="bg-gray-900 rounded-xl p-4 space-y-4">
          <h2 className="text-white font-bold text-sm uppercase tracking-widest">Assists</h2>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">Traction Control</p>
            <SegmentedControl
              options={[{ value: 'off', label: 'Off' }, { value: 'medium', label: 'Medium' }, { value: 'full', label: 'Full' }]}
              value={assists.traction_control}
              onChange={(v) => updateAssist('traction_control', v)}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">ABS</p>
            <SegmentedControl
              options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              value={assists.abs}
              onChange={(v) => updateAssist('abs', v)}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">Braking Assist</p>
            <SegmentedControl
              options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              value={assists.braking_assist}
              onChange={(v) => updateAssist('braking_assist', v)}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">Steering Assist</p>
            <SegmentedControl
              options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
              value={assists.steering_assist}
              onChange={(v) => updateAssist('steering_assist', v)}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">Gearbox</p>
            <SegmentedControl
              options={[
                { value: 'manual', label: 'Manual' },
                { value: 'manual_suggested', label: 'Manual + Suggested' },
                { value: 'automatic', label: 'Automatic' },
              ]}
              value={assists.gearbox}
              onChange={(v) => updateAssist('gearbox', v)}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-400 text-xs font-semibold uppercase">Dynamic Racing Line</p>
            <SegmentedControl
              options={[
                { value: 'off', label: 'Off' },
                { value: 'corners_only', label: 'Corners Only' },
                { value: 'full', label: 'Full' },
              ]}
              value={assists.dynamic_racing_line}
              onChange={(v) => updateAssist('dynamic_racing_line', v)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            {([
              ['pit_assist', 'Pit Assist'],
              ['ers_assist', 'ERS Assist'],
              ['drs_assist', 'DRS Assist'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => updateAssist(key, !assists[key])}
                className={`rounded-lg px-3 py-2 text-xs font-semibold border transition-colors ${
                  assists[key]
                    ? 'bg-[#E8284A]/15 border-[#E8284A] text-white'
                    : 'bg-black/30 border-gray-800 text-gray-500'
                }`}
              >
                {label}: {assists[key] ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 rounded-xl p-4 space-y-3">
          <h2 className="text-white font-bold text-sm uppercase tracking-widest">Comparison Drivers</h2>
          <input
            type="text"
            value={comparisonDrivers}
            onChange={(e) => setComparisonDrivers(e.target.value)}
            placeholder="e.g. drives like Verstappen — aggressive on entry"
            className="w-full rounded-lg bg-black/40 border border-gray-800 px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-[#E8284A]"
          />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything else worth knowing about your driving"
            rows={2}
            className="w-full rounded-lg bg-black/40 border border-gray-800 px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-[#E8284A] resize-none"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {savedMessage && !error && (
          <p className="text-xs text-green-400">{savedMessage}</p>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-lg bg-[#E8284A] py-2.5 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save Style Profile'}
        </button>
      </div>
    </div>
  )
}
