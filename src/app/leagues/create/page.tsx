'use client'

// src/app/leagues/create/page.tsx — Create a new league (you become commissioner)

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const SPORTS = [
  { value: 'sim_racing', label: 'Sim Racing', emoji: '🏎️' },
  { value: 'cfb', label: 'College Football', emoji: '🏈' },
]

export default function CreateLeaguePage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [sport, setSport] = useState('sim_racing')
  const [currency, setCurrency] = useState('')
  const [serverId, setServerId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/leagues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sport,
          currency_code: currency,
          discord_server_id: serverId,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not create league')
        return
      }
      router.push(data.next)
    } catch {
      setError('Network error — try again')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls =
    'w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red'
  const labelCls = 'text-xs text-white/40 uppercase tracking-widest mb-2 block'

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="flex items-center gap-2 text-white/40 text-sm mb-6">
        ← Back
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">
          Create a <span className="text-rise-red">League</span>
        </h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          You&rsquo;ll be the commissioner
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <label className={labelCls}>League name</label>
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Truth Racing League"
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls}>Sport</label>
          <div className="flex gap-2">
            {SPORTS.map((s) => (
              <button
                key={s.value}
                onClick={() => setSport(s.value)}
                className={`flex-1 rounded-xl py-3 text-xs font-bold uppercase tracking-wide ${
                  sport === s.value
                    ? 'bg-rise-red text-white'
                    : 'bg-white/5 text-white/40 border border-white/10'
                }`}
              >
                {s.emoji} {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelCls}>Currency code (optional)</label>
          <input
            type="text"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            placeholder="3 letters — defaults from your name"
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls}>Discord server ID (optional)</label>
          <input
            type="text"
            inputMode="numeric"
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            placeholder="You can add this later in setup"
            className={inputCls}
          />
        </div>

        {error && (
          <div className="rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
            <p className="text-xs text-rise-red">{error}</p>
          </div>
        )}

        <button
          onClick={submit}
          disabled={submitting || name.trim().length < 3}
          className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create League'}
        </button>
        <p className="text-xs text-white/30 text-center">
          New leagues start private in trial mode. Finish the setup checklist, then go live.
        </p>
      </div>
    </main>
  )
}
