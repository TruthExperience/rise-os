'use client'

// src/app/pitboss/steward/[id]/page.tsx
// Full incident detail view for stewards.
// Shows incident info, evidence, AI analysis, and the resolve panel.

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Incident {
  id: string
  incident_type: string
  description: string
  status: string
  verdict: string | null
  penalty: string | null
  penalty_points: number | null
  steward_notes: string | null
  override_reason: string | null
  season: string | null
  round: number | null
  lap: number | null
  evidence_urls: string[] | null
  reported_by: string
  accused_driver_id: string | null
  created_at: string
  resolved_at: string | null
  ai_verdict: string | null
  ai_penalty: string | null
  ai_points: number | null
  ai_reasoning: string | null
  ai_confidence: number | null
  ai_articles: string[] | null
  ai_model: string | null
  ai_analysed_at: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function confidenceColor(val: number | null) {
  if (!val) return 'text-gray-500'
  if (val >= 0.75) return 'text-green-400'
  if (val >= 0.5)  return 'text-yellow-400'
  return 'text-red-400'
}

function verdictColor(v: string | null) {
  if (!v) return 'text-gray-500'
  if (v === 'guilty')     return 'text-red-400'
  if (v === 'not_guilty') return 'text-green-400'
  return 'text-yellow-400'
}

function SectionHeader({ title }: { title: string }) {
  return (
    <p className="text-white/40 text-[10px] uppercase tracking-widest mb-3">{title}</p>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const leagueId = searchParams.get('league_id')
  const router = useRouter()
  const { data: session } = useSession()

  const [incident, setIncident] = useState<Incident | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  // AI analysis state
  const [analysing, setAnalysing] = useState(false)
  const [analyseError, setAnalyseError] = useState('')

  // Resolve form state
  const [showResolve, setShowResolve] = useState(false)
  const [verdict, setVerdict]         = useState('')
  const [penalty, setPenalty]         = useState('')
  const [penaltyPoints, setPenaltyPoints] = useState('')
  const [stewardNotes, setStewardNotes]   = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [resolving, setResolving]     = useState(false)
  const [resolveError, setResolveError] = useState('')

  useEffect(() => { loadIncident() }, [id])

  async function loadIncident() {
    setLoading(true)
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load incident')
      setIncident(data)

      // Pre-fill resolve form from AI suggestion if available
      if (data.ai_verdict)  setVerdict(data.ai_verdict)
      if (data.ai_penalty)  setPenalty(data.ai_penalty)
      if (data.ai_points)   setPenaltyPoints(String(data.ai_points))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleAnalyse() {
    setAnalysing(true)
    setAnalyseError('')
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyse' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI analysis failed')
      await loadIncident()
    } catch (err: any) {
      setAnalyseError(err.message)
    } finally {
      setAnalysing(false)
    }
  }

  async function handleResolve() {
    if (!verdict) return
    setResolving(true)
    setResolveError('')
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          verdict,
          penalty:        penalty || null,
          penalty_points: penaltyPoints ? Number(penaltyPoints) : 0,
          steward_notes:  stewardNotes || null,
          override_reason: overrideReason || null,
          resolved_by:    session?.user?.id ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to resolve incident')
      await loadIncident()
      setShowResolve(false)
    } catch (err: any) {
      setResolveError(err.message)
    } finally {
      setResolving(false)
    }
  }

  // ── Loading / error ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  if (error || !incident) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-rise-black px-6">
        <p className="text-rise-red text-center">{error || 'Incident not found'}</p>
        <button onClick={() => router.back()} className="text-white/40 underline text-sm">Go back</button>
      </main>
    )
  }

  const isResolved = incident.status === 'resolved'
  const hasAI = !!incident.ai_analysed_at

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-rise-black pb-28">

      {/* Header */}
      <div className="px-4 pt-12 pb-4 border-b border-white/10">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-3 block">← Back</button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-white font-black text-xl leading-tight">{incident.incident_type}</h1>
            <p className="text-white/30 text-xs mt-0.5">{formatDate(incident.created_at)}</p>
          </div>
          <span className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${
            isResolved
              ? 'border-green-400/30 text-green-400 bg-green-400/10'
              : 'border-rise-red/30 text-rise-red bg-rise-red/10'
          }`}>
            {incident.status}
          </span>
        </div>
      </div>

      <div className="px-4 pt-5 space-y-6">

        {/* Context */}
        <div>
          <SectionHeader title="Incident Details" />
          <div className="bg-white/5 rounded-2xl px-4 py-2 space-y-0">
            {[
              { label: 'Season', value: incident.season },
              { label: 'Round',  value: incident.round ? `Round ${incident.round}` : null },
              { label: 'Lap',    value: incident.lap   ? `Lap ${incident.lap}`    : null },
            ].filter(r => r.value).map(r => (
              <div key={r.label} className="flex justify-between py-2 border-b border-white/5 last:border-0">
                <span className="text-white/40 text-sm">{r.label}</span>
                <span className="text-white text-sm">{r.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Description */}
        <div>
          <SectionHeader title="Description" />
          <div className="bg-white/5 rounded-2xl px-4 py-4">
            <p className="text-white/80 text-sm leading-relaxed">{incident.description}</p>
          </div>
        </div>

        {/* Evidence */}
        {incident.evidence_urls && incident.evidence_urls.length > 0 && (
          <div>
            <SectionHeader title="Evidence" />
            <div className="space-y-2">
              {incident.evidence_urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3"
                >
                  <span className="text-rise-red text-sm">▶</span>
                  <span className="text-white/70 text-sm truncate">{url}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* AI Analysis */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <SectionHeader title="AI Steward Analysis" />
            {!isResolved && (
              <button
                onClick={handleAnalyse}
                disabled={analysing}
                className="text-xs font-bold text-rise-red disabled:text-white/20"
              >
                {analysing ? 'Analysing…' : hasAI ? '↺ Re-analyse' : '⚡ Analyse'}
              </button>
            )}
          </div>

          {analyseError && (
            <p className="text-red-400 text-xs mb-3">{analyseError}</p>
          )}

          {!hasAI ? (
            <div className="bg-white/5 rounded-2xl px-4 py-6 text-center">
              <p className="text-white/30 text-sm">No AI analysis yet.</p>
              <p className="text-white/20 text-xs mt-1">Tap ⚡ Analyse to run the AI steward.</p>
            </div>
          ) : (
            <div className="bg-white/5 rounded-2xl px-4 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Verdict</p>
                  <p className={`text-base font-black uppercase ${verdictColor(incident.ai_verdict)}`}>
                    {incident.ai_verdict?.replace('_', ' ') ?? '—'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Confidence</p>
                  <p className={`text-base font-black ${confidenceColor(incident.ai_confidence)}`}>
                    {incident.ai_confidence ? `${Math.round(Number(incident.ai_confidence) * 100)}%` : '—'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">PP</p>
                  <p className="text-white font-black text-base">{incident.ai_points ?? 0}</p>
                </div>
              </div>

              {incident.ai_penalty && (
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Suggested Penalty</p>
                  <p className="text-white text-sm">{incident.ai_penalty}</p>
                </div>
              )}

              {incident.ai_reasoning && (
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Reasoning</p>
                  <p className="text-white/70 text-sm leading-relaxed">{incident.ai_reasoning}</p>
                </div>
              )}

              {incident.ai_articles && incident.ai_articles.length > 0 && (
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Cited Articles</p>
                  <div className="flex flex-wrap gap-2">
                    {incident.ai_articles.map((a, i) => (
                      <span key={i} className="text-xs bg-rise-red/10 text-rise-red border border-rise-red/20 px-2 py-0.5 rounded-full">
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-white/20 text-[10px]">
                {incident.ai_model} · {formatDate(incident.ai_analysed_at)}
              </p>
            </div>
          )}
        </div>

        {/* Final verdict (if resolved) */}
        {isResolved && (
          <div>
            <SectionHeader title="Final Ruling" />
            <div className="bg-white/5 rounded-2xl px-4 py-4 space-y-3">
              <div className="flex justify-between">
                <span className="text-white/40 text-sm">Verdict</span>
                <span className={`text-sm font-bold uppercase ${verdictColor(incident.verdict)}`}>
                  {incident.verdict?.replace('_', ' ') ?? '—'}
                </span>
              </div>
              {incident.penalty && (
                <div className="flex justify-between">
                  <span className="text-white/40 text-sm">Penalty</span>
                  <span className="text-white text-sm">{incident.penalty}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-white/40 text-sm">Penalty Points</span>
                <span className="text-orange-400 font-bold text-sm">{incident.penalty_points ?? 0} PP</span>
              </div>
              {incident.steward_notes && (
                <div>
                  <p className="text-white/40 text-xs mb-1">Steward Notes</p>
                  <p className="text-white/70 text-sm leading-relaxed">{incident.steward_notes}</p>
                </div>
              )}
              {incident.override_reason && (
                <div>
                  <p className="text-white/40 text-xs mb-1">Override Reason</p>
                  <p className="text-yellow-400/80 text-sm leading-relaxed">{incident.override_reason}</p>
                </div>
              )}
              <p className="text-white/20 text-xs">Resolved {formatDate(incident.resolved_at)}</p>
            </div>
          </div>
        )}

        {/* Resolve Panel */}
        {!isResolved && (
          <div>
            <button
              onClick={() => setShowResolve(!showResolve)}
              className="w-full bg-rise-red text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest"
            >
              {showResolve ? 'Cancel' : 'Issue Ruling'}
            </button>

            {showResolve && (
              <div className="mt-4 space-y-4">

                {/* Verdict */}
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Verdict</p>
                  <div className="grid grid-cols-3 gap-2">
                    {['guilty', 'not_guilty', 'inconclusive'].map((v) => (
                      <button
                        key={v}
                        onClick={() => setVerdict(v)}
                        className={`py-3 rounded-xl text-xs font-bold uppercase transition-colors ${
                          verdict === v
                            ? 'bg-rise-red text-white'
                            : 'bg-white/5 text-white/50'
                        }`}
                      >
                        {v.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Penalty */}
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Penalty</p>
                  <input
                    type="text"
                    value={penalty}
                    onChange={(e) => setPenalty(e.target.value)}
                    placeholder="e.g. +5s time penalty, Grid penalty…"
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                  />
                </div>

                {/* PP */}
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Penalty Points</p>
                  <input
                    type="number"
                    value={penaltyPoints}
                    onChange={(e) => setPenaltyPoints(e.target.value)}
                    placeholder="0"
                    min="0"
                    max="12"
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                  />
                </div>

                {/* Steward Notes */}
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Steward Notes</p>
                  <textarea
                    value={stewardNotes}
                    onChange={(e) => setStewardNotes(e.target.value)}
                    placeholder="Explain the ruling and reasoning…"
                    rows={4}
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20 resize-none"
                  />
                </div>

                {/* Override reason (if diverging from AI) */}
                {hasAI && verdict !== incident.ai_verdict && (
                  <div>
                    <p className="text-yellow-400 text-xs uppercase tracking-widest mb-2">
                      ⚠ Override Reason (differs from AI)
                    </p>
                    <textarea
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Why are you overriding the AI suggestion?"
                      rows={3}
                      className="w-full bg-yellow-400/5 text-white text-sm px-4 py-3 rounded-xl border border-yellow-400/20 focus:border-yellow-400/50 focus:outline-none placeholder-white/20 resize-none"
                    />
                  </div>
                )}

                {resolveError && (
                  <p className="text-red-400 text-sm">{resolveError}</p>
                )}

                <button
                  onClick={handleResolve}
                  disabled={!verdict || resolving}
                  className="w-full bg-rise-red disabled:bg-white/10 disabled:text-white/20 text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest"
                >
                  {resolving ? 'Saving…' : 'Confirm Ruling'}
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </main>
  )
}
