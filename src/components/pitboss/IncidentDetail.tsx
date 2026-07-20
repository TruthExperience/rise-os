'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { StewardDiscussion } from '@/components/pitboss/StewardDiscussion'
import { EvidenceCapture, type EvidenceItem } from '@/components/pitboss/EvidenceCapture'

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
  ai_penalty_explanation: string | null
  ai_penalty_explanation_at: string | null
  accused_response: string | null
  accused_response_at: string | null
  accused_evidence_urls: string[] | null
  reporter?: { discord_username: string; display_name: string | null }
  accused?: { discord_username: string; display_name: string | null }
  league?: { name: string; slug: string }
}

interface Appeal {
  id: string
  incident_id: string
  league_id: string
  appealed_by: string
  reason: string
  status: string
  original_verdict: string | null
  original_penalty: string | null
  original_penalty_points: number | null
  new_verdict: string | null
  new_penalty: string | null
  new_penalty_points: number | null
  review_notes: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
}

const TIME_PENALTIES = ['+3s', '+5s', '+10s', '+15s', 'Drive-Through', 'Pit Lane Start']
const GRID_PENALTIES = ['3 places', '5 places', '10 places', 'Back of Grid']
const BAN_PENALTIES  = ['Race Ban', 'Season Ban', 'Permanent Ban']

type PenaltyType = 'none' | 'time' | 'grid' | 'ban' | 'reprimand' | 'warning' | 'dsq'
type AppealAction = 'uphold' | 'overturn' | 'dismiss' | ''

const PENALTY_TYPE_LABELS: Record<PenaltyType, string> = {
  none:      'No Penalty',
  warning:   'Warning',
  reprimand: 'Reprimand',
  time:      'Time Penalty',
  grid:      'Grid Penalty',
  dsq:       'Disqualification',
  ban:       'Ban',
}

const APPEAL_STATUS_STYLES: Record<string, string> = {
  open:       'border-yellow-400/30 text-yellow-400 bg-yellow-400/10',
  overturned: 'border-blue-400/30 text-blue-400 bg-blue-400/10',
  upheld:     'border-green-400/30 text-green-400 bg-green-400/10',
  dismissed:  'border-white/20 text-white/50 bg-white/5',
}

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
  return <p className="text-white/40 text-[10px] uppercase tracking-widest mb-3">{title}</p>
}

function buildPenaltySummary(
  penaltyType: PenaltyType,
  timePenalty: string,
  gridPenalty: string,
  banPenalty: string,
  penaltyPoints: string
): string {
  const parts: string[] = []
  if (penaltyType === 'time' && timePenalty)      parts.push(timePenalty + ' time penalty')
  if (penaltyType === 'grid' && gridPenalty)      parts.push(gridPenalty + ' grid penalty')
  if (penaltyType === 'ban'  && banPenalty)       parts.push(banPenalty)
  if (penaltyType === 'dsq')                      parts.push('Disqualification')
  if (penaltyType === 'reprimand')                parts.push('Reprimand')
  if (penaltyType === 'warning')                  parts.push('Warning')
  if (penaltyPoints && Number(penaltyPoints) > 0) parts.push(penaltyPoints + ' PP')
  return parts.join(' + ') || 'No penalty'
}

export function IncidentDetail({ id }: { id: string }) {
  const router = useRouter()

  const [incident, setIncident]     = useState<Incident | null>(null)
  const [isAccused, setIsAccused]   = useState(false)
  const [isSteward, setIsSteward]   = useState(false)
  const [isReporter, setIsReporter] = useState(false)
  const [appeal, setAppeal]         = useState<Appeal | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')

  const [analysing, setAnalysing]         = useState(false)
  const [analyseError, setAnalyseError]   = useState('')

  const [showResolve, setShowResolve]         = useState(false)
  const [verdict, setVerdict]                 = useState('')
  const [penaltyType, setPenaltyType]         = useState<PenaltyType>('none')
  const [timePenalty, setTimePenalty]         = useState('')
  const [gridPenalty, setGridPenalty]         = useState('')
  const [banPenalty, setBanPenalty]           = useState('')
  const [penaltyPoints, setPenaltyPoints]     = useState('0')
  const [stewardNotes, setStewardNotes]       = useState('')
  const [overrideReason, setOverrideReason]   = useState('')
  const [resolving, setResolving]             = useState(false)
  const [resolveError, setResolveError]       = useState('')

  const [showDefence, setShowDefence]       = useState(false)
  const [defenceText, setDefenceText]       = useState('')
  const [defenceUrls, setDefenceUrls]       = useState('')
  const [submittingDefence, setSubmitting]  = useState(false)
  const [defenceError, setDefenceError]     = useState('')

  const [showAppealForm, setShowAppealForm]     = useState(false)
  const [appealReason, setAppealReason]         = useState('')
  const [appealSubmitting, setAppealSubmitting] = useState(false)
  const [appealError, setAppealError]           = useState('')

  const [showDecide, setShowDecide]                   = useState(false)
  const [decideAction, setDecideAction]               = useState<AppealAction>('')
  const [decideVerdict, setDecideVerdict]             = useState('')
  const [decidePenalty, setDecidePenalty]             = useState('')
  const [decidePenaltyPoints, setDecidePenaltyPoints] = useState('0')
  const [decideNotes, setDecideNotes]                 = useState('')
  const [decideSubmitting, setDecideSubmitting]       = useState(false)
  const [decideError, setDecideError]                 = useState('')

  // Evidence state
  const [evidence, setEvidence]               = useState<EvidenceItem[]>([])
  const [showAddEvidence, setShowAddEvidence] = useState(false)
  const [evidenceParty, setEvidenceParty]     = useState<'reporter' | 'accused'>('reporter')

  useEffect(() => { loadIncident() }, [id])

  async function loadEvidence() {
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}/evidence`)
      const data = await res.json()
      if (res.ok) setEvidence(data.evidence ?? [])
    } catch {
      // non-fatal
    }
  }

  async function loadIncident() {
    setLoading(true)
    try {
      const res  = await fetch(`/api/pitboss/incidents/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load incident')
      const inc = data.incident
      setIncident(inc)
      setIsAccused(data.isAccused ?? false)
      setIsSteward(data.isSteward ?? false)
      setIsReporter(data.isReporter ?? false)
      setAppeal(data.appeal ?? null)
      if (inc.ai_verdict) setVerdict(inc.ai_verdict)
      if (inc.ai_points)  setPenaltyPoints(String(inc.ai_points))
      if (inc.accused_response) setDefenceText(inc.accused_response)
      if (inc.accused_evidence_urls) setDefenceUrls((inc.accused_evidence_urls as string[]).join('\n'))
      // Default the evidence party toggle to whichever side this viewer
      // actually is, so a non-steward can't accidentally post as the other party.
      if (data.isAccused) setEvidenceParty('accused')
      else setEvidenceParty('reporter')
      await loadEvidence()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleEvidenceAdded(item: EvidenceItem) {
    setEvidence((prev) => [...prev, item])
    setShowAddEvidence(false)
  }

  async function handleAnalyse() {
    setAnalysing(true)
    setAnalyseError('')
    try {
      const res  = await fetch(`/api/pitboss/incidents/${id}`, {
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
      const penaltySummary = buildPenaltySummary(
        penaltyType, timePenalty, gridPenalty, banPenalty, penaltyPoints
      )
      const res  = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:          'resolve',
          verdict,
          penalty:         penaltyType !== 'none' ? penaltySummary : null,
          penalty_points:  penaltyPoints ? Number(penaltyPoints) : 0,
          steward_notes:   stewardNotes  || null,
          override_reason: overrideReason || null,
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

  async function handleSubmitDefence() {
    if (!defenceText.trim()) return
    setSubmitting(true)
    setDefenceError('')
    try {
      const urls = defenceUrls.split('\n').map((u) => u.trim()).filter(Boolean)
      const res  = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accused_response:      defenceText.trim(),
          accused_evidence_urls: urls.length > 0 ? urls : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to submit defence')
      await loadIncident()
      setShowDefence(false)
    } catch (err: any) {
      setDefenceError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleFileAppeal() {
    if (!appealReason.trim()) return
    setAppealSubmitting(true)
    setAppealError('')
    try {
      const res  = await fetch(`/api/pitboss/incidents/${id}/appeal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: appealReason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to file appeal')
      await loadIncident()
      setShowAppealForm(false)
      setAppealReason('')
    } catch (err: any) {
      setAppealError(err.message)
    } finally {
      setAppealSubmitting(false)
    }
  }

  async function handleDecideAppeal() {
    if (!decideAction) return
    setDecideSubmitting(true)
    setDecideError('')
    try {
      const res  = await fetch(`/api/pitboss/incidents/${id}/appeal/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:             decideAction,
          new_verdict:        decideAction === 'overturn' ? decideVerdict : undefined,
          new_penalty:        decideAction === 'overturn' ? (decidePenalty || null) : undefined,
          new_penalty_points: decideAction === 'overturn' ? (decidePenaltyPoints ? Number(decidePenaltyPoints) : 0) : undefined,
          review_notes:       decideNotes || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to decide appeal')
      await loadIncident()
      setShowDecide(false)
    } catch (err: any) {
      setDecideError(err.message)
    } finally {
      setDecideSubmitting(false)
    }
  }

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

  const isResolved  = incident.status === 'resolved'
  const isAppealed  = incident.status === 'appealed'
  const hasAI       = !!incident.ai_analysed_at
  const hasDefence  = !!incident.accused_response
  const canDefend   = (isAccused || isSteward) && !isResolved
  const canAppeal   = isResolved && !appeal && (isAccused || isReporter || isSteward)

  return (
    <main className="min-h-screen bg-rise-black pb-28">

      <div className="px-4 pt-12 pb-4 border-b border-white/10">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-3 block">← Back</button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-white font-black text-xl leading-tight">{incident.incident_type}</h1>
            <p className="text-white/30 text-xs mt-0.5">{formatDate(incident.created_at)}</p>
            {incident.league && (
              <p className="text-white/20 text-xs mt-0.5 uppercase tracking-widest">{incident.league.name}</p>
            )}
          </div>
          <span className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${
            isResolved
              ? 'border-green-400/30 text-green-400 bg-green-400/10'
              : isAppealed
              ? 'border-yellow-400/30 text-yellow-400 bg-yellow-400/10'
              : 'border-rise-red/30 text-rise-red bg-rise-red/10'
          }`}>
            {incident.status}
          </span>
        </div>
      </div>

      <div className="px-4 pt-5 space-y-6">

        {(incident.reporter || incident.accused) && (
          <div>
            <SectionHeader title="Parties" />
            <div className="bg-white/5 rounded-2xl px-4 py-2">
              {incident.reporter && (
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/40 text-sm">Reporter</span>
                  <span className="text-white text-sm">
                    {incident.reporter.display_name ?? incident.reporter.discord_username}
                  </span>
                </div>
              )}
              {incident.accused && (
                <div className="flex justify-between py-2">
                  <span className="text-white/40 text-sm">Accused</span>
                  <span className="text-white text-sm">
                    {incident.accused.display_name ?? incident.accused.discord_username}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <SectionHeader title="Incident Details" />
          <div className="bg-white/5 rounded-2xl px-4 py-2">
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
            {!incident.season && !incident.round && !incident.lap && (
              <p className="text-white/20 text-sm py-2">No context provided.</p>
            )}
          </div>
        </div>

        <div>
          <SectionHeader title="Description" />
          <div className="bg-white/5 rounded-2xl px-4 py-4">
            <p className="text-white/80 text-sm leading-relaxed">{incident.description}</p>
          </div>
        </div>

        {/* Evidence */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <SectionHeader title="Evidence" />
            {(isSteward || isReporter || isAccused) && !isResolved && (
              <button onClick={() => setShowAddEvidence(!showAddEvidence)} className="text-xs font-bold text-blue-400">
                {showAddEvidence ? 'Cancel' : '+ Add Evidence'}
              </button>
            )}
          </div>

          {showAddEvidence && (
            <div className="space-y-3 mb-3">
              {isSteward && (
                <div className="grid grid-cols-2 gap-2">
                  {(['reporter', 'accused'] as const).map((p) => (
                    <button key={p} onClick={() => setEvidenceParty(p)}
                      className={`py-2.5 rounded-xl text-xs font-bold uppercase transition-colors ${evidenceParty === p ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/50'}`}>
                      For {p}
                    </button>
                  ))}
                </div>
              )}
              <EvidenceCapture
                incidentId={id}
                party={evidenceParty}
                onAdded={handleEvidenceAdded}
                compact
              />
            </div>
          )}

          {evidence.length > 0 ? (
            <div className="space-y-2">
              {evidence.map((e) => (
                <a key={e.id} href={e.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3">
                  <span className="text-rise-red text-sm">▶</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white/70 text-sm truncate">{e.label || e.url}</p>
                    <p className="text-white/20 text-[10px] uppercase tracking-widest">
                      {e.party} · added by {e.added_by_role}{e.legacy ? ' · legacy' : ''}
                    </p>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-white/20 text-sm">No evidence added yet.</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <SectionHeader title="Accused Driver Defence" />
            {canDefend && (
              <button onClick={() => setShowDefence(!showDefence)} className="text-xs font-bold text-blue-400">
                {showDefence ? 'Cancel' : hasDefence ? '✏️ Edit Defence' : '✏️ Add Defence'}
              </button>
            )}
          </div>

          {showDefence ? (
            <div className="space-y-3">
              <textarea
                value={defenceText}
                onChange={(e) => setDefenceText(e.target.value)}
                placeholder="Explain the accused driver's side of the incident…"
                rows={5}
                className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-blue-500/30 focus:border-blue-400/60 focus:outline-none placeholder-white/20 resize-none"
              />
              <div>
                <p className="text-white/40 text-[10px] uppercase tracking-widest mb-2">
                  Evidence Links (one per line)
                </p>
                <textarea
                  value={defenceUrls}
                  onChange={(e) => setDefenceUrls(e.target.value)}
                  placeholder="https://youtube.com/..."
                  rows={3}
                  className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/60 focus:outline-none placeholder-white/20 resize-none"
                />
              </div>
              {defenceError && <p className="text-red-400 text-sm">{defenceError}</p>}
              <button
                onClick={handleSubmitDefence}
                disabled={!defenceText.trim() || submittingDefence}
                className="w-full bg-blue-600 disabled:bg-white/10 disabled:text-white/20 text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest"
              >
                {submittingDefence ? 'Submitting…' : 'Submit Defence'}
              </button>
            </div>
          ) : hasDefence ? (
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-2xl px-4 py-4 space-y-3">
              <p className="text-white/80 text-sm leading-relaxed">{incident.accused_response}</p>
              {incident.accused_evidence_urls && incident.accused_evidence_urls.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-white/10">
                  <p className="text-white/40 text-[10px] uppercase tracking-widest">Defence Evidence</p>
                  {incident.accused_evidence_urls.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2">
                      <span className="text-blue-400 text-sm">▶</span>
                      <span className="text-white/70 text-xs truncate">{url}</span>
                    </a>
                  ))}
                </div>
              )}
              <p className="text-white/20 text-[10px]">
                Submitted {formatDate(incident.accused_response_at)}
              </p>
            </div>
          ) : (
            <div className="bg-white/5 rounded-2xl px-4 py-6 text-center">
              <p className="text-white/30 text-sm">No defence submitted yet.</p>
              {canDefend && (
                <p className="text-white/20 text-xs mt-1">Tap ✏️ Add Defence to submit a POV.</p>
              )}
            </div>
          )}
        </div>

        {isSteward && (
          <div>
            <SectionHeader title="Steward Discussion" />
            <StewardDiscussion incidentId={id} />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-3">
            <SectionHeader title="AI Steward Analysis" />
            {isSteward && !isResolved && (
              <button onClick={handleAnalyse} disabled={analysing}
                className="text-xs font-bold text-rise-red disabled:text-white/20">
                {analysing ? 'Analysing…' : hasAI ? '↺ Re-analyse' : '⚡ Analyse'}
              </button>
            )}
          </div>

          {analyseError && <p className="text-red-400 text-xs mb-3">{analyseError}</p>}

          {!hasAI ? (
            <div className="bg-white/5 rounded-2xl px-4 py-6 text-center">
              <p className="text-white/30 text-sm">No AI analysis yet.</p>
              {isSteward && <p className="text-white/20 text-xs mt-1">Tap ⚡ Analyse to run the AI steward.</p>}
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
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Suggested PP</p>
                  <p className="text-orange-400 font-black text-base">{incident.ai_points ?? 0} PP</p>
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
                      <span key={i} className="text-xs bg-rise-red/10 text-rise-red border border-rise-red/20 px-2 py-0.5 rounded-full">{a}</span>
                    ))}
                  </div>
                </div>
              )}
              {incident.ai_penalty_explanation && (
                <div className="pt-3 border-t border-white/10">
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Suggested Explanation (for driver)</p>
                  <p className="text-white/70 text-sm leading-relaxed">{incident.ai_penalty_explanation}</p>
                </div>
              )}
              <p className="text-white/20 text-[10px]">{incident.ai_model} · {formatDate(incident.ai_analysed_at)}</p>
            </div>
          )}
        </div>

        {(isResolved || isAppealed) && (
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
                  <span className="text-white text-sm font-semibold">{incident.penalty}</span>
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
                  <p className="text-yellow-400 text-xs mb-1">Override Reason</p>
                  <p className="text-yellow-400/80 text-sm leading-relaxed">{incident.override_reason}</p>
                </div>
              )}
              <p className="text-white/20 text-xs">Resolved {formatDate(incident.resolved_at)}</p>
            </div>
          </div>
        )}

        {(isResolved || isAppealed) && (
          <div>
            <SectionHeader title="Appeal" />

            {appeal ? (
              <div className="bg-white/5 rounded-2xl px-4 py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-white/40 text-sm">Status</span>
                  <span className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${
                    APPEAL_STATUS_STYLES[appeal.status] ?? APPEAL_STATUS_STYLES.dismissed
                  }`}>
                    {appeal.status}
                  </span>
                </div>
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Reason</p>
                  <p className="text-white/70 text-sm leading-relaxed">{appeal.reason}</p>
                </div>
                <p className="text-white/20 text-[10px]">Filed {formatDate(appeal.created_at)}</p>

                {appeal.status !== 'open' && (
                  <div className="pt-3 border-t border-white/10 space-y-2">
                    {appeal.review_notes && (
                      <div>
                        <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Review Notes</p>
                        <p className="text-white/70 text-sm leading-relaxed">{appeal.review_notes}</p>
                      </div>
                    )}
                    {appeal.status === 'overturned' && (
                      <div className="flex justify-between">
                        <span className="text-white/40 text-sm">New Verdict</span>
                        <span className={`text-sm font-bold uppercase ${verdictColor(appeal.new_verdict)}`}>
                          {appeal.new_verdict?.replace('_', ' ')}
                        </span>
                      </div>
                    )}
                    <p className="text-white/20 text-[10px]">Reviewed {formatDate(appeal.reviewed_at)}</p>
                  </div>
                )}

                {isSteward && appeal.status === 'open' && (
                  <div className="pt-4 border-t border-white/10">
                    <button
                      onClick={() => setShowDecide(!showDecide)}
                      className="w-full bg-blue-600 text-white font-black py-3 rounded-2xl text-xs uppercase tracking-widest"
                    >
                      {showDecide ? 'Cancel' : 'Review Appeal'}
                    </button>

                    {showDecide && (
                      <div className="mt-4 space-y-4">
                        <div>
                          <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Decision</p>
                          <div className="grid grid-cols-3 gap-2">
                            {(['uphold', 'overturn', 'dismiss'] as const).map((a) => (
                              <button key={a} onClick={() => setDecideAction(a)}
                                className={`py-3 rounded-xl text-xs font-bold uppercase transition-colors ${decideAction === a ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/50'}`}>
                                {a}
                              </button>
                            ))}
                          </div>
                        </div>

                        {decideAction === 'overturn' && (
                          <>
                            <div>
                              <p className="text-white/40 text-xs uppercase tracking-widest mb-2">New Verdict</p>
                              <div className="grid grid-cols-3 gap-2">
                                {(['guilty', 'not_guilty', 'inconclusive'] as const).map((v) => (
                                  <button key={v} onClick={() => setDecideVerdict(v)}
                                    className={`py-3 rounded-xl text-xs font-bold uppercase transition-colors ${decideVerdict === v ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/50'}`}>
                                    {v.replace('_', ' ')}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div>
                              <p className="text-white/40 text-xs uppercase tracking-widest mb-2">New Penalty (label)</p>
                              <input value={decidePenalty} onChange={(e) => setDecidePenalty(e.target.value)}
                                placeholder="e.g. +5s time penalty"
                                className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/50 focus:outline-none placeholder-white/20" />
                            </div>
                            <div>
                              <p className="text-white/40 text-xs uppercase tracking-widest mb-2">New Penalty Points</p>
                              <input type="number" value={decidePenaltyPoints} onChange={(e) => setDecidePenaltyPoints(e.target.value)}
                                placeholder="0" min="0" max="12"
                                className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/50 focus:outline-none placeholder-white/20" />
                            </div>
                          </>
                        )}

                        <div>
                          <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Review Notes</p>
                          <textarea value={decideNotes} onChange={(e) => setDecideNotes(e.target.value)}
                            placeholder="Explain the appeal decision…" rows={3}
                            className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/50 focus:outline-none placeholder-white/20 resize-none" />
                        </div>

                        {decideError && <p className="text-red-400 text-sm">{decideError}</p>}

                        <button
                          onClick={handleDecideAppeal}
                          disabled={!decideAction || (decideAction === 'overturn' && !decideVerdict) || decideSubmitting}
                          className="w-full bg-blue-600 disabled:bg-white/10 disabled:text-white/20 text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest"
                        >
                          {decideSubmitting ? 'Saving…' : 'Confirm Decision'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : canAppeal ? (
              !showAppealForm ? (
                <button
                  onClick={() => setShowAppealForm(true)}
                  className="w-full bg-white/5 border border-white/10 text-white font-bold py-4 rounded-2xl text-sm uppercase tracking-widest"
                >
                  File Appeal
                </button>
              ) : (
                <div className="space-y-3">
                  <textarea
                    value={appealReason}
                    onChange={(e) => setAppealReason(e.target.value)}
                    placeholder="Explain why this ruling should be appealed…"
                    rows={4}
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-blue-400/50 focus:outline-none placeholder-white/20 resize-none"
                  />
                  {appealError && <p className="text-red-400 text-sm">{appealError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowAppealForm(false)}
                      className="flex-1 bg-white/5 text-white/50 font-semibold py-3 rounded-xl text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleFileAppeal}
                      disabled={!appealReason.trim() || appealSubmitting}
                      className="flex-1 bg-blue-600 disabled:bg-white/10 disabled:text-white/20 text-white font-bold py-3 rounded-xl text-sm"
                    >
                      {appealSubmitting ? 'Submitting…' : 'Submit Appeal'}
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="bg-white/5 rounded-2xl px-4 py-6 text-center">
                <p className="text-white/30 text-sm">No appeal filed.</p>
              </div>
            )}
          </div>
        )}

        {isSteward && !isResolved && !isAppealed && (
          <div>
            <button
              onClick={() => setShowResolve(!showResolve)}
              className="w-full bg-rise-red text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest"
            >
              {showResolve ? 'Cancel' : 'Issue Ruling'}
            </button>

            {showResolve && (
              <div className="mt-4 space-y-5">

                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Verdict</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(['guilty', 'not_guilty', 'inconclusive'] as const).map((v) => (
                      <button key={v} onClick={() => setVerdict(v)}
                        className={`py-3 rounded-xl text-xs font-bold uppercase transition-colors ${verdict === v ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                        {v.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Penalty Type</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(PENALTY_TYPE_LABELS) as PenaltyType[]).map((t) => (
                      <button key={t} onClick={() => setPenaltyType(t)}
                        className={`py-3 rounded-xl text-xs font-bold transition-colors ${penaltyType === t ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                        {PENALTY_TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>

                {penaltyType === 'time' && (
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Time Penalty</p>
                    <div className="grid grid-cols-3 gap-2">
                      {TIME_PENALTIES.map((t) => (
                        <button key={t} onClick={() => setTimePenalty(t)}
                          className={`py-3 rounded-xl text-xs font-bold transition-colors ${timePenalty === t ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {penaltyType === 'grid' && (
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Grid Penalty</p>
                    <div className="grid grid-cols-2 gap-2">
                      {GRID_PENALTIES.map((g) => (
                        <button key={g} onClick={() => setGridPenalty(g)}
                          className={`py-3 rounded-xl text-xs font-bold transition-colors ${gridPenalty === g ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                          {g}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {penaltyType === 'ban' && (
                  <div>
                    <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Ban Type</p>
                    <div className="grid grid-cols-1 gap-2">
                      {BAN_PENALTIES.map((b) => (
                        <button key={b} onClick={() => setBanPenalty(b)}
                          className={`py-3 rounded-xl text-xs font-bold transition-colors ${banPenalty === b ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                          {b}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Penalty Points (PP)</p>
                  <div className="grid grid-cols-6 gap-2 mb-2">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((n) => (
                      <button key={n} onClick={() => setPenaltyPoints(String(n))}
                        className={`py-2.5 rounded-xl text-xs font-bold transition-colors ${penaltyPoints === String(n) ? 'bg-rise-red text-white' : 'bg-white/5 text-white/50'}`}>
                        {n}
                      </button>
                    ))}
                  </div>
                  <input type="number" value={penaltyPoints} onChange={(e) => setPenaltyPoints(e.target.value)}
                    placeholder="Custom PP amount" min="0" max="12"
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20" />
                </div>

                {(penaltyType !== 'none' || Number(penaltyPoints) > 0) && (
                  <div className="bg-rise-red/5 border border-rise-red/20 rounded-xl px-4 py-3">
                    <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Ruling Preview</p>
                    <p className="text-white font-semibold text-sm">
                      {buildPenaltySummary(penaltyType, timePenalty, gridPenalty, banPenalty, penaltyPoints)}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Steward Notes</p>
                  <textarea value={stewardNotes} onChange={(e) => setStewardNotes(e.target.value)}
                    placeholder="Explain the ruling and reasoning…" rows={4}
                    className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20 resize-none" />
                </div>

                {hasAI && verdict !== incident.ai_verdict && verdict !== '' && (
                  <div>
                    <p className="text-yellow-400 text-xs uppercase tracking-widest mb-2">
                      ⚠ Override Reason (differs from AI)
                    </p>
                    <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Why are you overriding the AI suggestion?" rows={3}
                      className="w-full bg-yellow-400/5 text-white text-sm px-4 py-3 rounded-xl border border-yellow-400/20 focus:border-yellow-400/50 focus:outline-none placeholder-white/20 resize-none" />
                  </div>
                )}

                {resolveError && <p className="text-red-400 text-sm">{resolveError}</p>}

                <button onClick={handleResolve} disabled={!verdict || resolving}
                  className="w-full bg-rise-red disabled:bg-white/10 disabled:text-white/20 text-white font-black py-4 rounded-2xl text-sm uppercase tracking-widest">
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
