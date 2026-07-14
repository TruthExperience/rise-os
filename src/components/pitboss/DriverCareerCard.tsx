// File: components/pitboss/CareerDriverRatingsCard.tsx
//
// Drop this into whatever page hosts the driver/career profile. Handles both
// states in one component:
//   - No career_mode_drivers row yet -> "Create Career Driver" form
//   - Row exists -> live ratings with editable sliders + "Save Changes",
//     for adjusting stats as the season/career progresses
//
// Styled to match SetupsPage: bg-[#1A1A1A], border-gray-800/gray-900,
// #E8284A accent, uppercase tracking-widest section headers.

'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

interface CareerDriver {
  id: string
  driver_id: string
  driver_name: string
  pace: number
  racecraft: number
  awareness: number
  experience: number
  focus: number
  overall: number
  notes: string | null
  created_at: string
  updated_at: string
}

type StatKey = 'pace' | 'racecraft' | 'awareness' | 'experience' | 'focus'

const STAT_LABELS: { key: StatKey; short: string; label: string }[] = [
  { key: 'pace', short: 'PAC', label: 'Pace' },
  { key: 'racecraft', short: 'RAC', label: 'Racecraft' },
  { key: 'awareness', short: 'AWA', label: 'Awareness' },
  { key: 'experience', short: 'EXP', label: 'Experience' },
  { key: 'focus', short: 'FOC', label: 'Focus' },
]

// Mirrors computeOverall() in the API routes — kept in sync manually for a
// live preview while dragging. The server always recomputes and is the
// source of truth; this is display-only.
function previewOverall(stats: Record<StatKey, number>): number {
  return Math.round(
    stats.pace * 0.35 +
      stats.racecraft * 0.2 +
      stats.awareness * 0.2 +
      stats.experience * 0.15 +
      stats.focus * 0.1
  )
}

function RatingSlider({
  short, label, value, onChange, disabled,
}: {
  short: string; label: string; value: number
  onChange: (v: number) => void; disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-white text-xs font-semibold uppercase tracking-wide">
          <span className="text-[#E8284A] mr-1.5">{short}</span>{label}
        </span>
        <span className="text-white font-mono text-sm font-bold">{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={99}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-gray-800 accent-[#E8284A] disabled:opacity-40"
      />
    </div>
  )
}

export default function CareerDriverRatingsCard() {
  const { data: session } = useSession()
  const discordId = session?.user?.discordId

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')

  const [careerDriver, setCareerDriver] = useState<CareerDriver | null>(null)
  const [driverName, setDriverName] = useState('')
  const [stats, setStats] = useState<Record<StatKey, number>>({
    pace: 50, racecraft: 50, awareness: 50, experience: 50, focus: 50,
  })

  useEffect(() => {
    if (!discordId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const res = await fetch(`/api/pitboss/career-drivers?discord_id=${discordId}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Failed to load career driver')
        if (!cancelled && data.career_driver) {
          const cd: CareerDriver = data.career_driver
          setCareerDriver(cd)
          setDriverName(cd.driver_name)
          setStats({
            pace: cd.pace,
            racecraft: cd.racecraft,
            awareness: cd.awareness,
            experience: cd.experience,
            focus: cd.focus ?? 50,
          })
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [discordId])

  function updateStat(key: StatKey, value: number) {
    setStats((prev) => ({ ...prev, [key]: value }))
    setSavedMessage('')
  }

  async function handleCreate() {
    if (!discordId || !driverName.trim()) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/pitboss/career-drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discord_id: discordId, driver_name: driverName.trim(), ...stats }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create career driver')
      setCareerDriver(data.career_driver)
      setSavedMessage('Career driver created.')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveChanges() {
    if (!discordId || !careerDriver) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/pitboss/career-drivers/${careerDriver.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discord_id: discordId, ...stats }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save changes')
      setCareerDriver(data.career_driver)
      setSavedMessage('Ratings updated.')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <p className="text-gray-500 text-sm animate-pulse">Loading career driver…</p>
      </div>
    )
  }

  const isCreateMode = !careerDriver
  const overall = previewOverall(stats)

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-bold text-base uppercase tracking-widest">
          {isCreateMode ? 'Create Career Driver' : 'Career Driver Ratings'}
        </h2>
        <div className="text-right">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">RTG</p>
          <p className="text-white font-mono text-xl font-black">{overall}</p>
        </div>
      </div>

      {isCreateMode ? (
        <input
          type="text"
          value={driverName}
          onChange={(e) => setDriverName(e.target.value)}
          placeholder="Driver name"
          className="w-full rounded-lg bg-black/40 border border-gray-800 px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-[#E8284A]"
        />
      ) : (
        <p className="text-gray-500 text-sm">
          {careerDriver!.driver_name} · last updated{' '}
          {new Date(careerDriver!.updated_at).toLocaleDateString()}
        </p>
      )}

      <div className="space-y-3">
        {STAT_LABELS.map(({ key, short, label }) => (
          <RatingSlider
            key={key}
            short={short}
            label={label}
            value={stats[key]}
            onChange={(v) => updateStat(key, v)}
            disabled={saving}
          />
        ))}
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
        onClick={isCreateMode ? handleCreate : handleSaveChanges}
        disabled={saving || (isCreateMode && !driverName.trim())}
        className="w-full rounded-lg bg-[#E8284A] py-2.5 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : isCreateMode ? 'Create Career Driver' : 'Save Changes'}
      </button>
    </div>
  )
}
