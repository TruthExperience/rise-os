'use client'

import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { DriverPicker, type DriverOption } from '@/components/pitboss/DriverPicker'

const TYPE_LABELS: Record<string, string> = {
  'Dangerous Driving':        '🚨 Dangerous Driving',
  'Illegal Overtake':         '🔀 Illegal Overtake',
  'Divebomb':                 '🚀 Divebomb',
  'Unsafe Rejoin':            '↩️ Unsafe Rejoin',
  'Collision / Contact':      '💥 Collision / Contact',
  'Blocking / Brake Test':    '🛑 Blocking / Brake Test',
  'Track Limits':             '📏 Track Limits',
  'Pit Lane Infringement':    '🅿️ Pit Lane Infringement',
  'Unsportsmanlike Conduct':  '😤 Unsportsmanlike Conduct',
  'No-Show / Late Join':      '👻 No-Show / Late Join',
  'Other':                    '📋 Other',
}

const STATUS_COLORS: Record<string, string> = {
  open:      'text-rise-red',
  reviewing: 'text-yellow-400',
  resolved:  'text-green-400',
}

// ─── New Ticket Form ──────────────────────────────────────────────────────────
function NewTicketForm({
  leagueId,
  onCreated,
  onCancel,
}: {
  leagueId: string
  onCreated: () => void
  onCancel: () => void
}) {
  const [incidentType, setIncidentType] = useState('Collision / Contact')
  const [description, setDescription] = useState('')
  const [accused, setAccused] = useState<DriverOption | null>(null)
  const [reporter, setReporter] = useState<DriverOption | null>(null)
  const [season, setSeason] = useState('')
  const [round, setRound] = useState('')
  const [lap, setLap] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    if (!description.trim()) {
      setError('Description is required')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/pitboss/steward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id: leagueId,
          incident_type: incidentType,
          description: description.trim(),
          accused_driver_id: accused?.id ?? null,
          reported_by: reporter?.id ?? null, // omit -> defaults to filing steward
          season: season || null,
          round: round ? Number(round) : null,
          lap: lap ? Number(lap) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to open ticket')
      onCreated()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4 mb-6">
      <p className="text-white font-bold text-base">Open New Ticket</p>

      <div>
        <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Incident Type</p>
        <div className="grid grid-cols-1 gap-2">
          {Object.keys(TYPE_LABELS).map((t) => (
            <button
              key={t}
              onClick={() => setIncidentType(t)}
              className={`py-3 px-4 rounded-xl text-sm font-bold text-left transition-colors ${
                incidentType === t ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'
              }`}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <DriverPicker
        leagueId={leagueId}
        label="Accused Driver"
        value={accused}
        onChange={setAccused}
        placeholder="Search accused driver…"
      />

      <DriverPicker
        leagueId={leagueId}
        label="Reported By"
        value={reporter}
        onChange={setReporter}
        placeholder="Search reporter (defaults to you if left blank)…"
      />

      <div>
        <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Description</p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the incident…"
          rows={4}
          className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20 resize-none"
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <input
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          placeholder="Season"
          className="bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
        />
        <input
          value={round}
          onChange={(e) => setRound(e.target.value)}
          placeholder="Round"
          type="number"
          className="bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
        />
        <input
          value={lap}
          onChange={(e) => setLap(e.target.value)}
          placeholder="Lap"
          type="number"
          className="bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
        />
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 bg-white/5 text-white/50 font-semibold py-3 rounded-xl text-sm"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !description.trim()}
          className="flex-1 bg-rise-red disabled:bg-white/10 disabled:text-white/20 text-white font-bold py-3 rounded-xl text-sm"
        >
          {submitting ? 'Opening…' : 'Open Ticket'}
        </button>
      </div>
    </div>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
export function StewardInner() {
  const { data: session, status } = useSession()
  const router       = useRouter()
  const searchParams = useSearchParams()
  const league_id    = searchParams.get('league_id')

  const [incidents, setIncidents] = useState<any[]>([])
  const [loading, setLoading]     = useState(true)
  const [filter, setFilter]       = useState<'open' | 'resolved'>('open')
  const [showNewTicket, setShowNewTicket] = useState(false)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status])

  useEffect(() => {
    if (league_id) fetchIncidents()
  }, [league_id, filter])

  async function fetchIncidents() {
    setLoading(true)
    try {
      const res = await fetch(`/api/pitboss/steward?league_id=${league_id}&status=${filter}`)
      if (res.ok) setIncidents((await res.json()).incidents ?? [])
    } finally {
      setLoading(false)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="text-white/40 text-sm mb-6 flex items-center gap-2">
        ← Back
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-white mb-1">Steward Panel</h1>
          <p className="text-white/30 text-xs uppercase tracking-widest">Incident Review</p>
        </div>
        {league_id && !showNewTicket && (
          <button
            onClick={() => setShowNewTicket(true)}
            className="bg-rise-red text-white text-xs font-bold uppercase tracking-widest px-4 py-2.5 rounded-full"
          >
            + New Ticket
          </button>
        )}
      </div>

      {league_id && showNewTicket && (
        <NewTicketForm
          leagueId={league_id}
          onCancel={() => setShowNewTicket(false)}
          onCreated={() => {
            setShowNewTicket(false)
            setFilter('open')
            fetchIncidents()
          }}
        />
      )}

      <div className="flex gap-2 mb-6">
        {(['open', 'resolved'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${
              filter === f ? 'bg-rise-red text-white' : 'bg-white/5 text-white/40'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {incidents.length === 0 ? (
        <p className="text-white/30 text-sm text-center mt-16">No {filter} incidents.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map(inc => (
            <button
              key={inc.id}
              onClick={() => router.push(`/pitboss/steward/${inc.id}?league_id=${league_id}`)}
              className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-white text-sm font-bold">
                  {TYPE_LABELS[inc.incident_type] ?? inc.incident_type}
                </span>
                <span className={`text-[10px] font-bold uppercase ${STATUS_COLORS[inc.status] ?? 'text-white/40'}`}>
                  {inc.status}
                </span>
              </div>
              <p className="text-white/50 text-xs line-clamp-2 mb-3">{inc.description}</p>
              <div className="flex items-center justify-between">
                <p className="text-white/30 text-[10px]">
                  {new Date(inc.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </p>
                {inc.verdict && (
                  <p className="text-white/40 text-[10px] capitalize">
                    {inc.verdict.replace('_', ' ')}
                    {inc.penalty_points ? ` · ${inc.penalty_points} PP` : ''}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </main>
  )
}
