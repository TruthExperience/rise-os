'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAGUE_META: Record<string, {
  name: string
  slug: string
  incidentTypes: string[]
  openToAll: boolean
}> = {
  '3a005e8d-c35f-4a57-aa27-c59c0c3812e2': {
    name: 'Truth Racing League',
    slug: 'trl',
    openToAll: false,
    incidentTypes: [
      'Illegal Divebomb',
      'Axle Rule Violation',
      'Unsafe Rejoin',
      'No Movement Under Braking Violation',
      'Retaliation / Double-Strike',
      'Targeting',
      'Track Limits',
      'Corner Cut',
      'Unsportsmanlike Conduct',
      'Other',
    ],
  },
  'a2fbdea9-5db9-4ca3-b5c9-981d1558120d': {
    name: 'World Series Championship',
    slug: 'wsc',
    openToAll: true,
    incidentTypes: [
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Unsafe Rejoin',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Track Limits',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
  'e9d9fa80-074c-4bc5-a696-f53edc0e6cdf': {
    name: 'Apex World Championship',
    slug: 'awc',
    openToAll: true,
    incidentTypes: [
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Unsafe Rejoin',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Track Limits',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeagueMembership {
  league_id: string
  role: string
  league: { id: string; name: string; slug: string } | null
}

interface Driver {
  id: string
  discord_username: string
  display_name: string | null
}

type Step = 'league' | 'details' | 'accused' | 'evidence' | 'review' | 'submitted'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TRL_PRIVILEGED = ['team_principal', 'sporting_director', 'commissioner', 'head_steward']

function canSubmitInLeague(leagueId: string, role: string): boolean {
  const meta = LEAGUE_META[leagueId]
  if (!meta) return false
  if (meta.openToAll) return true
  const roles = role.split(',').map((r) => r.trim().toLowerCase())
  return roles.some((r) => TRL_PRIVILEGED.includes(r))
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    open: 'text-yellow-400',
    under_review: 'text-blue-400',
    resolved: 'text-green-400',
    dismissed: 'text-white/30',
  }
  return map[status] ?? 'text-white/40'
}

function statusDot(status: string) {
  const map: Record<string, string> = {
    open: 'bg-yellow-400',
    under_review: 'bg-blue-400',
    resolved: 'bg-green-400',
    dismissed: 'bg-white/30',
  }
  return map[status] ?? 'bg-white/40'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${
            i < current ? 'bg-rise-red' : i === current ? 'bg-rise-red/60' : 'bg-white/10'
          }`}
        />
      ))}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-white/40 text-xs uppercase tracking-widest mb-2">{children}</p>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-white/10 last:border-0">
      <span className="text-white/40 text-sm flex-shrink-0">{label}</span>
      <span className="text-white text-sm text-right">{value || '—'}</span>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { data: session, status: authStatus } = useSession()
  const router = useRouter()

  // My league memberships (filtered to submittable leagues)
  const [eligibleLeagues, setEligibleLeagues] = useState<LeagueMembership[]>([])
  const [loadingLeagues, setLoadingLeagues] = useState(true)

  // League drivers for accused dropdown
  const [leagueDrivers, setLeagueDrivers] = useState<Driver[]>([])
  const [loadingDrivers, setLoadingDrivers] = useState(false)

  // Past incidents
  const [myIncidents, setMyIncidents] = useState<any[]>([])
  const [loadingIncidents, setLoadingIncidents] = useState(false)

  // Form state
  const [step, setStep] = useState<Step>('league')
  const [selectedLeagueId, setSelectedLeagueId] = useState('')
  const [incidentType, setIncidentType] = useState('')
  const [description, setDescription] = useState('')
  const [season, setSeason] = useState('')
  const [round, setRound] = useState('')
  const [lap, setLap] = useState('')
  const [accusedDriverId, setAccusedDriverId] = useState('')
  const [accusedManual, setAccusedManual] = useState('')
  const [useManual, setUseManual] = useState(false)
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  // ── Load memberships ───────────────────────────────────────────────────────
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    fetchMemberships()
  }, [authStatus])

  async function fetchMemberships() {
    setLoadingLeagues(true)
    try {
      const res = await fetch('/api/pitboss/me/leagues')
      const data = await res.json()
      const all: LeagueMembership[] = data.leagues ?? []
      const eligible = all.filter((m) => canSubmitInLeague(m.league_id, m.role))
      setEligibleLeagues(eligible)
    } catch {
      // ignore
    } finally {
      setLoadingLeagues(false)
    }
  }

  // ── Load drivers when league selected ─────────────────────────────────────
  useEffect(() => {
    if (!selectedLeagueId) return
    fetchLeagueDrivers(selectedLeagueId)
    fetchMyIncidents(selectedLeagueId)
  }, [selectedLeagueId])

  async function fetchLeagueDrivers(leagueId: string) {
    setLoadingDrivers(true)
    try {
      const res = await fetch(`/api/pitboss/leagues/${leagueId}/drivers`)
      const data = await res.json()
      setLeagueDrivers(data.drivers ?? [])
    } catch {
      setLeagueDrivers([])
    } finally {
      setLoadingDrivers(false)
    }
  }

  async function fetchMyIncidents(leagueId: string) {
    setLoadingIncidents(true)
    try {
      const res = await fetch(`/api/pitboss/incidents?league_id=${leagueId}`)
      const data = await res.json()
      setMyIncidents(data.incidents ?? [])
    } catch {
      setMyIncidents([])
    } finally {
      setLoadingIncidents(false)
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitting(true)
    setSubmitError('')
    try {
      const urls = evidenceUrls.filter((u) => u.trim().length > 0)
      const res = await fetch('/api/pitboss/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id: selectedLeagueId,
          incident_type: incidentType,
          description,
          season: season || null,
          round: round || null,
          lap: lap || null,
          evidence_urls: urls.length ? urls : null,
          accused_driver_id: !useManual && accusedDriverId ? accusedDriverId : null,
          accused_discord_username: useManual && accusedManual ? accusedManual : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submission failed')
      setStep('submitted')
      fetchMyIncidents(selectedLeagueId)
    } catch (err: any) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function resetForm() {
    setStep('league')
    setSelectedLeagueId('')
    setIncidentType('')
    setDescription('')
    setSeason('')
    setRound('')
    setLap('')
    setAccusedDriverId('')
    setAccusedManual('')
    setUseManual(false)
    setEvidenceUrls([''])
    setSubmitError('')
  }

  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (authStatus === 'loading') {
    return (
      <div className="min-h-screen bg-rise-black flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </div>
    )
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div className="min-h-screen bg-rise-black flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-white/40 text-center">Sign in to submit incident reports.</p>
        <button
          onClick={() => router.push('/login')}
          className="bg-rise-red text-white font-bold px-6 py-3 rounded-xl text-sm"
        >
          Sign In
        </button>
      </div>
    )
  }

  const selectedMeta = LEAGUE_META[selectedLeagueId]
  const accusedDriver = leagueDrivers.find((d) => d.id === accusedDriverId)
  const stepIndex = ['league', 'details', 'accused', 'evidence', 'review'].indexOf(step)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-rise-black pb-28">

      {/* Header */}
      <div className="px-4 pt-12 pb-4 border-b border-white/10">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-3 block">← Back</button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white font-black text-xl tracking-tight">Incident Reports</h1>
            <p className="text-white/30 text-sm mt-0.5">File a protest or report a sporting violation</p>
          </div>
          {selectedLeagueId && myIncidents.length > 0 && step !== 'submitted' && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs text-rise-red border border-rise-red/30 px-3 py-1.5 rounded-lg"
            >
              History ({myIncidents.length})
            </button>
          )}
        </div>
      </div>

      <div className="px-4 pt-5">

        {/* ── History Panel ─────────────────────────────────────────────── */}
        {showHistory && myIncidents.length > 0 && (
          <div className="mb-6 space-y-2">
            <p className="text-white/40 text-xs uppercase tracking-widest mb-3">Your Reports</p>
            {myIncidents.map((inc) => (
              <div key={inc.id} className="bg-white/5 rounded-xl px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-semibold truncate">{inc.incident_type}</p>
                    <p className="text-white/30 text-xs mt-0.5">{formatDate(inc.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot(inc.status)}`} />
                    <span className={`text-xs capitalize ${statusColor(inc.status)}`}>
                      {inc.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
                {inc.verdict && (
                  <p className="text-white/40 text-xs mt-1">
                    Verdict: <span className="text-white capitalize">{inc.verdict.replace('_', ' ')}</span>
                    {inc.penalty_points ? ` · ${inc.penalty_points} PP` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Submitted ─────────────────────────────────────────────────── */}
        {step === 'submitted' && (
          <div className="flex flex-col items-center justify-center py-16 gap-6">
            <div className="w-16 h-16 rounded-full bg-green-400/10 flex items-center justify-center">
              <span className="text-3xl">✓</span>
            </div>
            <div className="text-center">
              <h2 className="text-white font-black text-lg">Report Submitted</h2>
              <p className="text-white/40 text-sm mt-1">
                Your incident report has been filed and is pending steward review.
              </p>
            </div>
            <button
              onClick={resetForm}
              className="bg-rise-red text-white font-bold px-8 py-3 rounded-xl text-sm"
            >
              File Another Report
            </button>
          </div>
        )}

        {/* ── Step: League ──────────────────────────────────────────────── */}
        {step === 'league' && (
          <div>
            {loadingLeagues ? (
              <p className="text-white/30 text-sm animate-pulse">Loading your leagues…</p>
            ) : eligibleLeagues.length === 0 ? (
              <div className="bg-white/5 rounded-2xl px-5 py-8 text-center">
                <p className="text-white/40 text-sm">
                  You don't have permission to file incident reports in any of your leagues.
                </p>
                <p className="text-white/20 text-xs mt-2">
                  TRL requires Team Principal or Sporting Director role.
                </p>
              </div>
            ) : (
              <div>
                <p className="text-white/40 text-xs uppercase tracking-widest mb-4">Select League</p>
                <div className="space-y-3">
                  {eligibleLeagues.map((m) => {
                    const meta = LEAGUE_META[m.league_id]
                    return (
                      <button
                        key={m.league_id}
                        onClick={() => {
                          setSelectedLeagueId(m.league_id)
                          setStep('details')
                        }}
                        className="w-full bg-white/5 hover:bg-white/10 rounded-2xl px-5 py-4 text-left transition-colors border border-transparent hover:border-rise-red/30"
                      >
                        <p className="text-white font-bold text-base">{meta?.name ?? m.league?.name}</p>
                        <p className="text-white/30 text-xs mt-0.5 capitalize">
                          {m.role.replace(/_/g, ' ')} ·{' '}
                          {meta?.openToAll ? 'Open submission' : 'Restricted submission'}
                        </p>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step: Details ─────────────────────────────────────────────── */}
        {step === 'details' && selectedMeta && (
          <div>
            <StepIndicator current={1} total={4} />

            <div className="mb-5">
              <FieldLabel>League</FieldLabel>
              <div className="bg-white/5 rounded-xl px-4 py-3 flex items-center justify-between">
                <p className="text-white text-sm font-semibold">{selectedMeta.name}</p>
                <button onClick={resetForm} className="text-white/40 text-xs underline">Change</button>
              </div>
            </div>

            <div className="mb-5">
              <FieldLabel>Incident Type</FieldLabel>
              <div className="grid grid-cols-1 gap-2">
                {selectedMeta.incidentTypes.map((type) => (
                  <button
                    key={type}
                    onClick={() => setIncidentType(type)}
                    className={`text-left px-4 py-3 rounded-xl text-sm font-bold transition-colors ${
                      incidentType === type
                        ? 'bg-rise-red text-white'
                        : 'bg-white/5 text-white/50'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-5">
              <FieldLabel>Description</FieldLabel>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what happened — corner, positions involved, what the other driver did, impact on your race…"
                rows={5}
                className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20 resize-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 mb-6">
              <div>
                <FieldLabel>Season</FieldLabel>
                <input
                  type="text"
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                  placeholder="e.g. S7"
                  className="w-full bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                />
              </div>
              <div>
                <FieldLabel>Round</FieldLabel>
                <input
                  type="number"
                  value={round}
                  onChange={(e) => setRound(e.target.value)}
                  placeholder="e.g. 4"
                  className="w-full bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                />
              </div>
              <div>
                <FieldLabel>Lap</FieldLabel>
                <input
                  type="number"
                  value={lap}
                  onChange={(e) => setLap(e.target.value)}
                  placeholder="e.g. 12"
                  className="w-full bg-white/5 text-white text-sm px-3 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                />
              </div>
            </div>

            <button
              disabled={!incidentType || description.trim().length < 20}
              onClick={() => setStep('accused')}
              className="w-full bg-rise-red disabled:bg-white/10 disabled:text-white/20 text-white font-bold py-4 rounded-xl text-sm transition-colors"
            >
              Continue
            </button>
            {description.trim().length > 0 && description.trim().length < 20 && (
              <p className="text-white/20 text-xs text-center mt-2">Description must be at least 20 characters</p>
            )}
          </div>
        )}

        {/* ── Step: Accused ─────────────────────────────────────────────── */}
        {step === 'accused' && (
          <div>
            <StepIndicator current={2} total={4} />
            <p className="text-white/40 text-xs uppercase tracking-widest mb-4">Driver Involved</p>

            {/* Toggle */}
            <div className="flex bg-white/5 rounded-xl p-1 mb-5">
              <button
                onClick={() => setUseManual(false)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  !useManual ? 'bg-rise-red text-white' : 'text-white/40'
                }`}
              >
                Select from league
              </button>
              <button
                onClick={() => setUseManual(true)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  useManual ? 'bg-rise-red text-white' : 'text-white/40'
                }`}
              >
                Enter manually
              </button>
            </div>

            {!useManual ? (
              <div>
                {loadingDrivers ? (
                  <p className="text-white/30 text-sm animate-pulse">Loading drivers…</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    <button
                      onClick={() => setAccusedDriverId('')}
                      className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-colors ${
                        accusedDriverId === ''
                          ? 'bg-white/10 text-white/70'
                          : 'bg-white/5 text-white/40'
                      }`}
                    >
                      Not specified / Unknown
                    </button>
                    {leagueDrivers.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => setAccusedDriverId(d.id)}
                        className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-colors ${
                          accusedDriverId === d.id
                            ? 'bg-rise-red text-white'
                            : 'bg-white/5 text-white/50 font-normal'
                        }`}
                      >
                        {d.display_name ?? d.discord_username}
                        <span className="text-white/30 font-normal ml-1.5">@{d.discord_username}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <FieldLabel>Discord Username</FieldLabel>
                <input
                  type="text"
                  value={accusedManual}
                  onChange={(e) => setAccusedManual(e.target.value)}
                  placeholder="e.g. xjanx07x"
                  className="w-full bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                />
                <p className="text-white/20 text-xs mt-2">
                  Enter their Discord username without the @ symbol
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setStep('details')}
                className="flex-1 bg-white/5 text-white/50 font-semibold py-4 rounded-xl text-sm"
              >
                Back
              </button>
              <button
                onClick={() => setStep('evidence')}
                className="flex-1 bg-rise-red text-white font-bold py-4 rounded-xl text-sm"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Evidence ────────────────────────────────────────────── */}
        {step === 'evidence' && (
          <div>
            <StepIndicator current={3} total={4} />
            <p className="text-white/40 text-xs uppercase tracking-widest mb-1">Evidence Links</p>
            <p className="text-white/20 text-xs mb-4">
              Add video links (YouTube, Streamable, Medal, etc.). Optional but strongly recommended.
            </p>

            <div className="space-y-3 mb-4">
              {evidenceUrls.map((url, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => {
                      const updated = [...evidenceUrls]
                      updated[i] = e.target.value
                      setEvidenceUrls(updated)
                    }}
                    placeholder="https://youtube.com/watch?v=..."
                    className="flex-1 bg-white/5 text-white text-sm px-4 py-3 rounded-xl border border-white/10 focus:border-rise-red/50 focus:outline-none placeholder-white/20"
                  />
                  {evidenceUrls.length > 1 && (
                    <button
                      onClick={() => setEvidenceUrls(evidenceUrls.filter((_, j) => j !== i))}
                      className="text-white/20 text-lg px-2"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {evidenceUrls.length < 5 && (
              <button
                onClick={() => setEvidenceUrls([...evidenceUrls, ''])}
                className="text-rise-red text-sm mb-6"
              >
                + Add another link
              </button>
            )}

            <div className="flex gap-3 mt-2">
              <button
                onClick={() => setStep('accused')}
                className="flex-1 bg-white/5 text-white/50 font-semibold py-4 rounded-xl text-sm"
              >
                Back
              </button>
              <button
                onClick={() => setStep('review')}
                className="flex-1 bg-rise-red text-white font-bold py-4 rounded-xl text-sm"
              >
                Review
              </button>
            </div>
          </div>
        )}

        {/* ── Step: Review ──────────────────────────────────────────────── */}
        {step === 'review' && selectedMeta && (
          <div>
            <StepIndicator current={4} total={4} />
            <p className="text-white/40 text-xs uppercase tracking-widest mb-4">Review & Submit</p>

            <div className="bg-white/5 rounded-2xl px-4 py-2 mb-5">
              <ReviewRow label="League" value={selectedMeta.name} />
              <ReviewRow label="Incident Type" value={incidentType} />
              <ReviewRow label="Season" value={season} />
              <ReviewRow label="Round" value={round} />
              <ReviewRow label="Lap" value={lap} />
              <ReviewRow
                label="Driver Involved"
                value={
                  useManual
                    ? accusedManual || 'Not specified'
                    : accusedDriver
                    ? accusedDriver.display_name ?? accusedDriver.discord_username
                    : 'Not specified'
                }
              />
              <ReviewRow
                label="Evidence"
                value={
                  evidenceUrls.filter((u) => u.trim()).length > 0
                    ? `${evidenceUrls.filter((u) => u.trim()).length} link(s)`
                    : 'None provided'
                }
              />
            </div>

            <div className="bg-white/5 rounded-2xl px-4 py-4 mb-5">
              <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Description</p>
              <p className="text-white/70 text-sm leading-relaxed">{description}</p>
            </div>

            <div className="bg-rise-red/5 border border-rise-red/20 rounded-xl px-4 py-3 mb-6">
              <p className="text-white/40 text-xs leading-relaxed">
                By submitting this report you confirm the information provided is accurate to the best
                of your knowledge. False or malicious reports may result in disciplinary action.
              </p>
            </div>

            {submitError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4">
                <p className="text-red-400 text-sm">{submitError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('evidence')}
                className="flex-1 bg-white/5 text-white/50 font-semibold py-4 rounded-xl text-sm"
              >
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 bg-rise-red disabled:bg-rise-red/50 text-white font-bold py-4 rounded-xl text-sm"
              >
                {submitting ? 'Submitting…' : 'Submit Report'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
