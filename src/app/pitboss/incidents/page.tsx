'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { DriverPicker, type DriverOption } from '@/components/pitboss/DriverPicker'

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
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
  'a2fbdea9-5db9-4ca3-b5c9-981d1558120d': {
    name: 'World Series Championship',
    slug: 'wsc',
    openToAll: true,
    incidentTypes: [
      'Illegal Divebomb',
      'Axle Rule Violation',
      'Unsafe Rejoin',
      'No Movement Under Braking Violation',
      'Retaliation / Double-Strike',
      'Targeting',
      'Track Limits',
      'Corner Cut',
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Collision / Contact',
      'Blocking / Brake Test',
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
      'Illegal Divebomb',
      'Axle Rule Violation',
      'Unsafe Rejoin',
      'No Movement Under Braking Violation',
      'Retaliation / Double-Strike',
      'Targeting',
      'Track Limits',
      'Corner Cut',
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
  '7e8a009c-99ea-4252-b7d6-e48c58fc3cfd': {
    name: 'Slipstream Racing Hub',
    slug: 'slipstream-racing-hub',
    openToAll: true,
    incidentTypes: [
      'Illegal Divebomb',
      'Axle Rule Violation',
      'Unsafe Rejoin',
      'No Movement Under Braking Violation',
      'Retaliation / Double-Strike',
      'Targeting',
      'Track Limits',
      'Corner Cut',
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
  'b4fb9276-cdbd-49f8-b750-fe1c966e470a': {
    name: 'Aero Aces Racing League',
    slug: 'aarl',
    openToAll: true,
    incidentTypes: [
      'Illegal Divebomb',
      'Axle Rule Violation',
      'Unsafe Rejoin',
      'No Movement Under Braking Violation',
      'Retaliation / Double-Strike',
      'Targeting',
      'Track Limits',
      'Corner Cut',
      'Dangerous Driving',
      'Illegal Overtake',
      'Divebomb',
      'Collision / Contact',
      'Blocking / Brake Test',
      'Pit Lane Infringement',
      'Unsportsmanlike Conduct',
      'No-Show / Late Join',
      'Other',
    ],
  },
}

const TYPE_ICONS: Record<string, string> = {
  'Illegal Divebomb': '🚀',
  'Axle Rule Violation': '⚙️',
  'Unsafe Rejoin': '↩️',
  'No Movement Under Braking Violation': '🛑',
  'Retaliation / Double-Strike': '🥊',
  'Targeting': '🎯',
  'Corner Cut': '✂️',
  'Dangerous Driving': '🚨',
  'Illegal Overtake': '🔀',
  'Divebomb': '🚀',
  'Collision / Contact': '💥',
  'Blocking / Brake Test': '🛑',
  'Track Limits': '📏',
  'Pit Lane Infringement': '🅿️',
  'Unsportsmanlike Conduct': '😤',
  'No-Show / Late Join': '👻',
  'Other': '📋',
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeagueMembership {
  league_id: string
  role: string
  league: { id: string; name: string; slug: string } | null
}

type Screen = 'league' | 'form' | 'submitted'

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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { data: session, status: authStatus } = useSession()
  const router = useRouter()

  // My league memberships (filtered to submittable leagues)
  const [eligibleLeagues, setEligibleLeagues] = useState<LeagueMembership[]>([])
  const [loadingLeagues, setLoadingLeagues] = useState(true)

  // Past incidents
  const [myIncidents, setMyIncidents] = useState<any[]>([])
  const [loadingIncidents, setLoadingIncidents] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // Screen + selected league
  const [screen, setScreen] = useState<Screen>('league')
  const [selectedLeagueId, setSelectedLeagueId] = useState('')

  // Form state
  const [incidentType, setIncidentType] = useState('')
  const [description, setDescription] = useState('')
  const [season, setSeason] = useState('')
  const [round, setRound] = useState('')
  const [lap, setLap] = useState('')
  const [accused, setAccused] = useState<DriverOption | null>(null)
  const [useManual, setUseManual] = useState(false)
  const [accusedManual, setAccusedManual] = useState('')
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

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

  function selectLeague(leagueId: string) {
    setSelectedLeagueId(leagueId)
    setScreen('form')
    fetchMyIncidents(leagueId)
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!incidentType) {
      setSubmitError('Select an incident type')
      return
    }
    if (!description.trim()) {
      setSubmitError('Description is required')
      return
    }
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
          description: description.trim(),
          season: season || null,
          round: round || null,
          lap: lap || null,
          evidence_urls: urls.length ? urls : null,
          accused_driver_id: !useManual && accused ? accused.id : null,
          accused_discord_username: useManual && accusedManual ? accusedManual : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submission failed')
      setScreen('submitted')
      fetchMyIncidents(selectedLeagueId)
    } catch (err: any) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function resetForm() {
    setScreen('league')
    setSelectedLeagueId('')
    setIncidentType('')
    setDescription('')
    setSeason('')
    setRound('')
    setLap('')
    setAccused(null)
    setUseManual(false)
    setAccusedManual('')
    setEvidenceUrls([''])
    setSubmitError('')
  }

  // ── Auth guard ─────────────────────────────────────────────────────────────
  if (authStatus === 'loading') {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading…</p>
      </div>
    )
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-gray-400 text-center">Sign in to submit incident reports.</p>
        <button
          onClick={() => router.push('/login')}
          className="bg-[#E8284A] text-white font-bold px-6 py-3 rounded-xl text-sm"
        >
          Sign In
        </button>
      </div>
    )
  }

  const selectedMeta = LEAGUE_META[selectedLeagueId]

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-28">

      {/* Header */}
      <div className="px-4 pt-12 pb-4 border-b border-gray-800">
        <button
          onClick={() => (screen === 'league' ? router.back() : resetForm())}
          className="text-gray-500 text-sm mb-3 block"
        >
          ← Back
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white font-bold text-xl tracking-tight">
              {screen === 'league' ? 'Incident Reports' : selectedMeta?.name ?? 'Incident Reports'}
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">
              {screen === 'league'
                ? 'File a protest or report a sporting violation'
                : 'Report Incident'}
            </p>
          </div>
          {screen === 'form' && myIncidents.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs text-[#E8284A] border border-[#E8284A]/30 px-3 py-1.5 rounded-lg flex-shrink-0"
            >
              History ({myIncidents.length})
            </button>
          )}
        </div>
      </div>

      <div className="px-4 pt-5">

        {/* ── History Panel ─────────────────────────────────────────────── */}
        {showHistory && screen === 'form' && myIncidents.length > 0 && (
          <div className="mb-6 space-y-2">
            <p className="text-gray-400 text-xs uppercase tracking-widest mb-3">Your Reports</p>
            {myIncidents.map((inc) => (
              <button
                key={inc.id}
                onClick={() => router.push(`/pitboss/incidents/${inc.id}`)}
                className="w-full bg-gray-900 hover:bg-gray-800 rounded-xl px-4 py-3 text-left transition-colors active:scale-[0.98]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-semibold truncate">{inc.incident_type}</p>
                    <p className="text-gray-500 text-xs mt-0.5">{formatDate(inc.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot(inc.status)}`} />
                    <span className={`text-xs capitalize ${statusColor(inc.status)}`}>
                      {inc.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
                {inc.verdict && (
                  <p className="text-gray-400 text-xs mt-1">
                    Verdict: <span className="text-white capitalize">{inc.verdict.replace('_', ' ')}</span>
                    {inc.penalty_points ? ` · ${inc.penalty_points} PP` : ''}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Screen: Submitted ─────────────────────────────────────────── */}
        {screen === 'submitted' && (
          <div className="flex flex-col items-center justify-center py-16 gap-6">
            <div className="w-16 h-16 rounded-full bg-green-400/10 flex items-center justify-center">
              <span className="text-3xl">✓</span>
            </div>
            <div className="text-center">
              <h2 className="text-white font-bold text-lg">Report Submitted</h2>
              <p className="text-gray-400 text-sm mt-1">
                Your incident report has been filed and is pending steward review.
              </p>
            </div>
            <button
              onClick={resetForm}
              className="bg-[#E8284A] text-white font-bold px-8 py-3 rounded-xl text-sm"
            >
              File Another Report
            </button>
          </div>
        )}

        {/* ── Screen: League ────────────────────────────────────────────── */}
        {screen === 'league' && (
          <div>
            {loadingLeagues ? (
              <p className="text-gray-500 text-sm animate-pulse">Loading your leagues…</p>
            ) : eligibleLeagues.length === 0 ? (
              <div className="bg-gray-900 rounded-2xl px-5 py-8 text-center">
                <p className="text-gray-400 text-sm">
                  You don't have permission to file incident reports in any of your leagues.
                </p>
                <p className="text-gray-600 text-xs mt-2">
                  TRL requires Team Principal or Sporting Director role.
                </p>
              </div>
            ) : (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-widest mb-4">Select League</p>
                <div className="space-y-3">
                  {eligibleLeagues.map((m) => {
                    const meta = LEAGUE_META[m.league_id]
                    return (
                      <button
                        key={m.league_id}
                        onClick={() => selectLeague(m.league_id)}
                        className="w-full bg-gray-900 hover:bg-gray-800 rounded-2xl px-5 py-4 text-left transition-colors border border-transparent hover:border-[#E8284A]/30"
                      >
                        <p className="text-white font-bold text-base">{meta?.name ?? m.league?.name}</p>
                        <p className="text-gray-500 text-xs mt-0.5 capitalize">
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

        {/* ── Screen: Form ──────────────────────────────────────────────── */}
        {screen === 'form' && selectedMeta && (
          <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 space-y-4 mb-6">
            <p className="text-white font-bold text-base">Report Incident</p>

            <div>
              <p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Incident Type</p>
              <div className="grid grid-cols-1 gap-2">
                {selectedMeta.incidentTypes.map((t) => (
                  <button
                    key={t}
                    onClick={() => setIncidentType(t)}
                    className={`py-3 px-4 rounded-xl text-sm font-bold text-left transition-colors flex items-center gap-2.5 ${
                      incidentType === t ? 'bg-[#E8284A] text-white' : 'bg-gray-800 text-gray-300'
                    }`}
                  >
                    <span>{TYPE_ICONS[t] ?? '📋'}</span>
                    <span>{t}</span>
                  </button>
                ))}
              </div>
            </div>

            {!useManual ? (
              <div>
                <DriverPicker
                  leagueId={selectedLeagueId}
                  label="Accused Driver"
                  value={accused}
                  onChange={setAccused}
                  placeholder="Search accused driver…"
                />
                <button
                  onClick={() => setUseManual(true)}
                  className="text-gray-500 text-xs underline mt-2"
                >
                  Can't find them? Enter manually
                </button>
              </div>
            ) : (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Accused Driver</p>
                <input
                  type="text"
                  value={accusedManual}
                  onChange={(e) => setAccusedManual(e.target.value)}
                  placeholder="e.g. xjanx07x"
                  className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
                />
                <button
                  onClick={() => { setUseManual(false); setAccusedManual('') }}
                  className="text-gray-500 text-xs underline mt-2"
                >
                  Search league drivers instead
                </button>
              </div>
            )}

            <div>
              <p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Description</p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the incident…"
                rows={4}
                className="w-full bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600 resize-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <input
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                placeholder="Season"
                className="bg-gray-800 text-white text-sm px-3 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
              />
              <input
                value={round}
                onChange={(e) => setRound(e.target.value)}
                placeholder="Round"
                type="number"
                className="bg-gray-800 text-white text-sm px-3 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
              />
              <input
                value={lap}
                onChange={(e) => setLap(e.target.value)}
                placeholder="Lap"
                type="number"
                className="bg-gray-800 text-white text-sm px-3 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
              />
            </div>

            <div>
              <p className="text-gray-400 text-xs uppercase tracking-widest mb-1">Evidence Links</p>
              <p className="text-gray-600 text-xs mb-3">
                Add video links (YouTube, Streamable, Medal, etc.). Optional but strongly recommended.
              </p>
              <div className="space-y-2">
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
                      placeholder="https://youtube.com/watch?v=…"
                      className="flex-1 bg-gray-800 text-white text-sm px-4 py-3 rounded-xl border border-gray-700 focus:border-[#E8284A]/50 focus:outline-none placeholder-gray-600"
                    />
                    {evidenceUrls.length > 1 && (
                      <button
                        onClick={() => setEvidenceUrls(evidenceUrls.filter((_, j) => j !== i))}
                        className="text-gray-600 text-lg px-2"
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
                  className="text-[#E8284A] text-sm mt-2"
                >
                  + Add another link
                </button>
              )}
            </div>

            <div className="bg-[#E8284A]/5 border border-[#E8284A]/20 rounded-xl px-4 py-3">
              <p className="text-gray-400 text-xs leading-relaxed">
                By submitting this report you confirm the information provided is accurate to the best
                of your knowledge. False or malicious reports may result in disciplinary action.
              </p>
            </div>

            {submitError && <p className="text-red-400 text-xs">{submitError}</p>}

            <div className="flex gap-2">
              <button
                onClick={resetForm}
                className="flex-1 bg-gray-800 text-gray-300 font-semibold py-3 rounded-xl text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !description.trim() || !incidentType}
                className="flex-1 bg-[#E8284A] disabled:opacity-40 text-white font-bold py-3 rounded-xl text-sm"
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
