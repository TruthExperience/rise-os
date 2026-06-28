'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
  discord_avatar: string | null
}

interface RuleArticle {
  id: string
  article_number: string
  title: string
  body: string
  category: string
}

interface Incident {
  id: string
  league_id: string
  incident_type: string
  description: string
  season: string | null
  round: string | null
  lap: string | null
  status: string
  evidence_urls: string[] | null
  accused_response: string | null
  accused_evidence_urls: string[] | null
  accused_response_at: string | null
  verdict: string | null
  penalty: string | null
  penalty_points: number | null
  steward_notes: string | null
  override_reason: string | null
  resolved_at: string | null
  ai_verdict: string | null
  ai_penalty: string | null
  ai_points: number | null
  ai_confidence: number | null
  ai_reasoning: string | null
  ai_articles: string[] | null
  ai_model: string | null
  ai_analysed_at: string | null
  created_at: string
  reporter: Driver | null
  accused: Driver | null
  league: { id: string; name: string; slug: string } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avatarUrl(driver: Driver) {
  if (driver.discord_avatar) {
    return `https://cdn.discordapp.com/avatars/${driver.id}/${driver.discord_avatar}.png?size=64`
  }
  return null
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    open: 'text-yellow-400',
    under_review: 'text-blue-400',
    resolved: 'text-green-400',
    dismissed: 'text-gray-500',
  }
  return map[status] ?? 'text-gray-400'
}

function statusDot(status: string) {
  const map: Record<string, string> = {
    open: 'bg-yellow-400',
    under_review: 'bg-blue-400',
    resolved: 'bg-green-400',
    dismissed: 'bg-gray-500',
  }
  return map[status] ?? 'bg-gray-400'
}

function verdictColor(v: string | null) {
  if (v === 'guilty') return 'text-red-400'
  if (v === 'not_guilty') return 'text-green-400'
  return 'text-yellow-400'
}

function confidencePct(c: number | null) {
  if (c === null) return '—'
  return `${Math.round(c * 100)}%`
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function isVideoUrl(url: string) {
  return (
    url.includes('youtube') ||
    url.includes('youtu.be') ||
    url.includes('twitch.tv') ||
    url.includes('medal.tv') ||
    url.includes('streamable') ||
    url.includes('discord')
  )
}

// ─── Article Drawer ───────────────────────────────────────────────────────────

function ArticleDrawer({
  article,
  onClose,
}: {
  article: RuleArticle
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full bg-[#1A1A1A] border-t border-gray-800 rounded-t-2xl max-h-[80vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#1A1A1A] px-4 pt-4 pb-3 border-b border-gray-800 flex items-start justify-between gap-3">
          <div>
            <p className="text-[#E8284A] text-xs font-bold uppercase tracking-widest">
              Article {article.article_number}
            </p>
            <h2 className="text-white font-bold text-base mt-0.5">{article.title}</h2>
            {article.category && (
              <p className="text-gray-500 text-xs mt-0.5">{article.category}</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 text-xl flex-shrink-0 mt-0.5">✕</button>
        </div>
        <div className="px-4 py-5">
          <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{article.body}</p>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IncidentDetailPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const { id } = useParams<{ id: string }>()

  const [incident, setIncident] = useState<Incident | null>(null)
  const [isSteward, setIsSteward] = useState(false)
  const [isAccused, setIsAccused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // AI analysis
  const [analysing, setAnalysing] = useState(false)
  const [analyseError, setAnalyseError] = useState('')

  // Rulebook articles for this league
  const [articles, setArticles] = useState<RuleArticle[]>([])
  const [selectedArticle, setSelectedArticle] = useState<RuleArticle | null>(null)
  const [loadingArticles, setLoadingArticles] = useState(false)

  // Defence form (accused)
  const [showDefenceForm, setShowDefenceForm] = useState(false)
  const [defenceText, setDefenceText] = useState('')
  const [defenceUrls, setDefenceUrls] = useState<string[]>([''])
  const [submittingDefence, setSubmittingDefence] = useState(false)
  const [defenceError, setDefenceError] = useState('')

  // Ruling form (steward)
  const [showRulingForm, setShowRulingForm] = useState(false)
  const [rulingVerdict, setRulingVerdict] = useState<'guilty' | 'not_guilty' | 'inconclusive'>('guilty')
  const [rulingPenalty, setRulingPenalty] = useState('')
  const [rulingPP, setRulingPP] = useState(0)
  const [rulingNotes, setRulingNotes] = useState('')
  const [rulingOverride, setRulingOverride] = useState('')
  const [submittingRuling, setSubmittingRuling] = useState(false)
  const [rulingError, setRulingError] = useState('')

  useEffect(() => {
    loadIncident()
  }, [id])

  async function loadIncident() {
    setLoading(true)
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load incident')
      setIncident(data.incident)
      setIsSteward(data.isSteward ?? false)
      setIsAccused(data.isAccused ?? false)
      if (data.incident?.league_id) {
        loadArticles(data.incident.league_id)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadArticles(leagueId: string) {
    setLoadingArticles(true)
    try {
      const res = await fetch(`/api/pitboss/rule-articles?league_id=${leagueId}`)
      const data = await res.json()
      setArticles(data.articles ?? [])
    } catch {
      // non-fatal
    } finally {
      setLoadingArticles(false)
    }
  }

  function findArticle(ref: string): RuleArticle | null {
    const clean = ref.replace(/^\[|\].*$/g, '').replace(/^Article\s*/i, '').trim()
    return (
      articles.find(
        (a) =>
          a.article_number === clean ||
          ref.toLowerCase().includes(a.article_number.toLowerCase()) ||
          ref.toLowerCase().includes(a.title.toLowerCase())
      ) ?? null
    )
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

  async function handleDefenceSubmit() {
    if (!defenceText.trim()) return
    setSubmittingDefence(true)
    setDefenceError('')
    try {
      const urls = defenceUrls.filter((u) => u.trim())
      const res = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accused_response: defenceText.trim(),
          accused_evidence_urls: urls.length ? urls : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to submit defence')
      setShowDefenceForm(false)
      await loadIncident()
    } catch (err: any) {
      setDefenceError(err.message)
    } finally {
      setSubmittingDefence(false)
    }
  }

  async function handleRulingSubmit() {
    setSubmittingRuling(true)
    setRulingError('')
    try {
      const res = await fetch(`/api/pitboss/incidents/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          verdict: rulingVerdict,
          penalty: rulingPenalty || null,
          penalty_points: rulingPP,
          steward_notes: rulingNotes || null,
          override_reason: rulingOverride || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to issue ruling')
      setShowRulingForm(false)
      await loadIncident()
    } catch (err: any) {
      setRulingError(err.message)
    } finally {
      setSubmittingRuling(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading incident…</p>
      </div>
    )
  }

  if (error || !incident) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-[#E8284A] text-center">{error || 'Incident not found'}</p>
        <button onClick={() => router.back()} className="text-gray-400 underline text-sm">Go back</button>
      </div>
    )
  }

  const hasAI = !!incident.ai_verdict
  const isResolved = incident.status === 'resolved' || incident.status === 'dismissed'

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-28">

      {selectedArticle && (
        <ArticleDrawer article={selectedArticle} onClose={() => setSelectedArticle(null)} />
      )}

      {/* Header */}
      <div className="px-4 pt-12 pb-4 border-b border-gray-800">
        <button onClick={() => router.back()} className="text-gray-500 text-sm mb-3 block">← Back</button>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-xl leading-tight">{incident.incident_type}</h1>
            <p className="text-gray-500 text-xs mt-1">{formatDate(incident.created_at)}</p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
            <span className={`w-2 h-2 rounded-full ${statusDot(incident.status)}`} />
            <span className={`text-xs font-semibold uppercase ${statusColor(incident.status)}`}>
              {incident.status.replace('_', ' ')}
            </span>
          </div>
        </div>
        {incident.league && (
          <p className="text-gray-600 text-xs mt-1">{incident.league.name}</p>
        )}
      </div>

      <div className="px-4 pt-5 space-y-5">

        {/* Incident Details */}
        <section className="bg-gray-900 rounded-2xl overflow-hidden">
          <p className="text-gray-500 text-xs uppercase tracking-widest px-4 pt-4 pb-2">Incident Details</p>
          <div className="divide-y divide-gray-800">
            {[
              { label: 'Season', value: incident.season },
              { label: 'Round', value: incident.round },
              { label: 'Lap', value: incident.lap },
            ].map(({ label, value }) => value && (
              <div key={label} className="flex justify-between px-4 py-3">
                <span className="text-gray-500 text-sm">{label}</span>
                <span className="text-white text-sm font-semibold">{value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Drivers */}
        <section className="space-y-2">
          {incident.reporter && (
            <div className="bg-gray-900 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gray-800 overflow-hidden flex-shrink-0">
                {avatarUrl(incident.reporter) ? (
                  <img src={avatarUrl(incident.reporter)!} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white text-xs font-bold">
                    {(incident.reporter.display_name ?? incident.reporter.discord_username)[0].toUpperCase()}
                  </div>
                )}
              </div>
              <div>
                <p className="text-white text-sm font-semibold">
                  {incident.reporter.display_name ?? incident.reporter.discord_username}
                </p>
                <p className="text-gray-500 text-xs">Reporter</p>
              </div>
            </div>
          )}
          {incident.accused && (
            <div className="bg-gray-900 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-[#E8284A]/20 overflow-hidden flex-shrink-0">
                {avatarUrl(incident.accused) ? (
                  <img src={avatarUrl(incident.accused)!} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#E8284A] text-xs font-bold">
                    {(incident.accused.display_name ?? incident.accused.discord_username)[0].toUpperCase()}
                  </div>
                )}
              </div>
              <div>
                <p className="text-white text-sm font-semibold">
                  {incident.accused.display_name ?? incident.accused.discord_username}
                </p>
                <p className="text-[#E8284A] text-xs">Accused</p>
              </div>
            </div>
          )}
        </section>

        {/* Description */}
        <section>
          <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Description</p>
          <div className="bg-gray-900 rounded-xl px-4 py-4">
            <p className="text-gray-300 text-sm leading-relaxed">{incident.description}</p>
          </div>
        </section>

        {/* Evidence */}
        {incident.evidence_urls && incident.evidence_urls.length > 0 && (
          <section>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Evidence</p>
            <div className="space-y-2">
              {incident.evidence_urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3"
                >
                  <span className="text-lg">{isVideoUrl(url) ? '▶️' : '🔗'}</span>
                  <span className="text-blue-400 text-sm truncate flex-1">{url}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Accused Response */}
        {incident.accused_response ? (
          <section>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Accused Response</p>
            <div className="bg-gray-900 rounded-xl px-4 py-4">
              <p className="text-gray-300 text-sm leading-relaxed">{incident.accused_response}</p>
              {incident.accused_response_at && (
                <p className="text-gray-600 text-xs mt-2">{formatDate(incident.accused_response_at)}</p>
              )}
            </div>
            {incident.accused_evidence_urls && incident.accused_evidence_urls.length > 0 && (
              <div className="space-y-2 mt-2">
                {incident.accused_evidence_urls.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3"
                  >
                    <span className="text-lg">▶️</span>
                    <span className="text-blue-400 text-sm truncate flex-1">{url}</span>
                  </a>
                ))}
              </div>
            )}
          </section>
        ) : isAccused && !isResolved ? (
          <section>
            {!showDefenceForm ? (
              <button
                onClick={() => setShowDefenceForm(true)}
                className="w-full bg-gray-900 border border-gray-700 text-gray-300 font-semibold py-3 rounded-xl text-sm"
              >
                Submit Your Response
              </button>
            ) : (
              <div className="bg-gray-900 rounded-2xl p-4 space-y-3">
                <p className="text-white font-semibold text-sm">Your Response</p>
                <textarea
                  value={defenceText}
                  onChange={(e) => setDefenceText(e.target.value)}
                  placeholder="Describe your perspective on the incident…"
                  rows={4}
                  className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600 resize-none"
                />
                {defenceUrls.map((url, i) => (
                  <input
                    key={i}
                    type="url"
                    value={url}
                    onChange={(e) => {
                      const updated = [...defenceUrls]
                      updated[i] = e.target.value
                      setDefenceUrls(updated)
                    }}
                    placeholder="Evidence URL (optional)"
                    className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
                  />
                ))}
                {defenceUrls.length < 3 && (
                  <button
                    onClick={() => setDefenceUrls([...defenceUrls, ''])}
                    className="text-[#E8284A] text-xs"
                  >
                    + Add evidence link
                  </button>
                )}
                {defenceError && <p className="text-red-400 text-xs">{defenceError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowDefenceForm(false)}
                    className="flex-1 bg-gray-800 text-gray-300 font-semibold py-3 rounded-xl text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDefenceSubmit}
                    disabled={!defenceText.trim() || submittingDefence}
                    className="flex-1 bg-[#E8284A] disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
                  >
                    {submittingDefence ? 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* AI Steward Analysis */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <p className="text-gray-500 text-xs uppercase tracking-widest">AI Steward Analysis</p>
            {isSteward && (
              <button
                onClick={handleAnalyse}
                disabled={analysing}
                className="text-[#E8284A] text-xs font-semibold flex items-center gap-1"
              >
                {analysing ? (
                  <span className="animate-pulse">Analysing…</span>
                ) : (
                  <span>⚡ {hasAI ? 'Re-analyse' : 'Analyse'}</span>
                )}
              </button>
            )}
          </div>

          {analyseError && (
            <p className="text-[#E8284A] text-xs mb-2">{analyseError}</p>
          )}

          {hasAI ? (
            <div className="bg-gray-900 rounded-2xl overflow-hidden">
              <div className="px-4 pt-4 pb-3 border-b border-gray-800 grid grid-cols-3">
                <div>
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Verdict</p>
                  <p className={`text-sm font-black uppercase ${verdictColor(incident.ai_verdict)}`}>
                    {incident.ai_verdict?.replace('_', ' ') ?? '—'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Confidence</p>
                  <p className={`text-sm font-black ${
                    (incident.ai_confidence ?? 0) >= 0.7
                      ? 'text-green-400'
                      : (incident.ai_confidence ?? 0) >= 0.4
                      ? 'text-yellow-400'
                      : 'text-red-400'
                  }`}>
                    {confidencePct(incident.ai_confidence)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">PP</p>
                  <p className="text-sm font-black text-white">{incident.ai_points ?? 0}</p>
                </div>
              </div>

              {incident.ai_penalty && (
                <div className="px-4 py-3 border-b border-gray-800">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Suggested Penalty</p>
                  <p className="text-gray-300 text-sm leading-relaxed">{incident.ai_penalty}</p>
                </div>
              )}

              {incident.ai_reasoning && (
                <div className="px-4 py-3 border-b border-gray-800">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Reasoning</p>
                  <p className="text-gray-300 text-sm leading-relaxed">{incident.ai_reasoning}</p>
                </div>
              )}

              {incident.ai_articles && incident.ai_articles.length > 0 && (
                <div className="px-4 py-3">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-2">Cited Articles</p>
                  <div className="flex flex-wrap gap-2">
                    {incident.ai_articles.map((ref, i) => {
                      const article = findArticle(ref)
                      return (
                        <button
                          key={i}
                          onClick={() => article ? setSelectedArticle(article) : null}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                            article
                              ? 'bg-[#E8284A]/10 border-[#E8284A]/40 text-[#E8284A] active:bg-[#E8284A]/20'
                              : 'bg-gray-800 border-gray-700 text-gray-500'
                          }`}
                        >
                          {ref}
                          {article && <span className="ml-1 opacity-60">↗</span>}
                        </button>
                      )
                    })}
                  </div>
                  {!loadingArticles && articles.length === 0 && (
                    <p className="text-gray-700 text-xs mt-2">No rulebook articles loaded for this league</p>
                  )}
                </div>
              )}

              {incident.ai_model && (
                <div className="px-4 pb-3">
                  <p className="text-gray-700 text-[10px]">
                    Model: {incident.ai_model} · {formatDate(incident.ai_analysed_at)}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-gray-900 rounded-2xl px-4 py-8 text-center">
              <p className="text-gray-600 text-sm">No AI analysis yet.</p>
              {isSteward && (
                <p className="text-gray-700 text-xs mt-1">Tap ⚡ Analyse to run the AI steward.</p>
              )}
            </div>
          )}
        </section>

        {/* Final Ruling */}
        {isResolved && (
          <section>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Final Ruling</p>
            <div className="bg-gray-900 rounded-2xl overflow-hidden">
              <div className="px-4 pt-4 pb-3 border-b border-gray-800 grid grid-cols-3">
                <div>
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Verdict</p>
                  <p className={`text-sm font-black uppercase ${verdictColor(incident.verdict)}`}>
                    {incident.verdict?.replace('_', ' ') ?? '—'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">PP</p>
                  <p className="text-sm font-black text-white">{incident.penalty_points ?? 0}</p>
                </div>
                <div className="text-right">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Resolved</p>
                  <p className="text-gray-400 text-xs">{formatDate(incident.resolved_at)}</p>
                </div>
              </div>
              {incident.penalty && (
                <div className="px-4 py-3 border-b border-gray-800">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Penalty</p>
                  <p className="text-gray-300 text-sm">{incident.penalty}</p>
                </div>
              )}
              {incident.steward_notes && (
                <div className="px-4 py-3 border-b border-gray-800">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Steward Notes</p>
                  <p className="text-gray-300 text-sm leading-relaxed">{incident.steward_notes}</p>
                </div>
              )}
              {incident.override_reason && (
                <div className="px-4 py-3">
                  <p className="text-gray-500 text-[10px] uppercase tracking-widest mb-1">Override Reason</p>
                  <p className="text-gray-400 text-sm">{incident.override_reason}</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Issue Ruling */}
        {isSteward && !isResolved && (
          <section>
            {!showRulingForm ? (
              <button
                onClick={() => setShowRulingForm(true)}
                className="w-full bg-[#E8284A] text-white font-black py-4 rounded-xl text-sm uppercase tracking-wider"
              >
                Issue Ruling
              </button>
            ) : (
              <div className="bg-gray-900 rounded-2xl p-4 space-y-4">
                <p className="text-white font-bold text-base">Issue Ruling</p>

                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Verdict</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(['guilty', 'not_guilty', 'inconclusive'] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setRulingVerdict(v)}
                        className={`py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors ${
                          rulingVerdict === v
                            ? v === 'guilty'
                              ? 'bg-red-500 text-white'
                              : v === 'not_guilty'
                              ? 'bg-green-500 text-white'
                              : 'bg-yellow-500 text-black'
                            : 'bg-gray-800 text-gray-500'
                        }`}
                      >
                        {v.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                {rulingVerdict === 'guilty' && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Penalty Points</p>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setRulingPP(Math.max(0, rulingPP - 1))}
                        className="w-10 h-10 bg-gray-800 rounded-xl text-white font-bold text-lg flex items-center justify-center"
                      >
                        −
                      </button>
                      <span className="text-white font-black text-2xl w-8 text-center">{rulingPP}</span>
                      <button
                        onClick={() => setRulingPP(Math.min(25, rulingPP + 1))}
                        className="w-10 h-10 bg-gray-800 rounded-xl text-white font-bold text-lg flex items-center justify-center"
                      >
                        +
                      </button>
                      {incident.ai_points !== null && incident.ai_points > 0 && (
                        <button
                          onClick={() => setRulingPP(incident.ai_points!)}
                          className="text-xs text-[#E8284A] ml-2"
                        >
                          Use AI ({incident.ai_points} PP)
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {rulingVerdict === 'guilty' && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Penalty Description</p>
                    <input
                      type="text"
                      value={rulingPenalty}
                      onChange={(e) => setRulingPenalty(e.target.value)}
                      placeholder="e.g. 3-race suspension, time penalty…"
                      className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
                    />
                  </div>
                )}

                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Steward Notes</p>
                  <textarea
                    value={rulingNotes}
                    onChange={(e) => setRulingNotes(e.target.value)}
                    placeholder="Explain the ruling…"
                    rows={3}
                    className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600 resize-none"
                  />
                </div>

                {hasAI && incident.ai_verdict !== rulingVerdict && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">
                      Override Reason <span className="text-[#E8284A]">*</span>
                    </p>
                    <p className="text-gray-600 text-xs mb-2">
                      Your verdict differs from AI ({incident.ai_verdict?.replace('_', ' ')}). Explain why.
                    </p>
                    <textarea
                      value={rulingOverride}
                      onChange={(e) => setRulingOverride(e.target.value)}
                      placeholder="Reason for overriding AI recommendation…"
                      rows={2}
                      className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-[#E8284A]/30 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600 resize-none"
                    />
                  </div>
                )}

                {rulingError && <p className="text-red-400 text-xs">{rulingError}</p>}

                <div className="flex gap-2">
                  <button
                    onClick={() => setShowRulingForm(false)}
                    className="flex-1 bg-gray-800 text-gray-300 font-semibold py-3 rounded-xl text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRulingSubmit}
                    disabled={
                      submittingRuling ||
                      (hasAI && incident.ai_verdict !== rulingVerdict && !rulingOverride.trim())
                    }
                    className="flex-1 bg-[#E8284A] disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
                  >
                    {submittingRuling ? 'Issuing…' : 'Confirm Ruling'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

      </div>
    </div>
  )
}
