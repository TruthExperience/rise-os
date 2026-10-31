'use client'

// src/app/pitboss/admin/setup/page.tsx — League Setup Dashboard
//
// Readiness checklist for a league, driven by GET /api/pitboss/admin/setup.
// Settings-backed checks (Discord IDs, currency, status, visibility) can be
// edited inline and are saved with PATCH /api/pitboss/admin/setup.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

type Status = 'done' | 'partial' | 'todo'

interface Check {
  id: string
  group: string
  label: string
  description: string
  status: Status
  detail: string
  required: boolean
  href?: string
  fields?: string[]
}

interface LeagueSettings {
  id: string
  name: string
  slug: string
  pitboss_status: string
  is_public: boolean
  currency_code: string | null
  [key: string]: any
}

interface SetupData {
  league: LeagueSettings
  checks: Check[]
  progress: { requiredTotal: number; requiredDone: number; percent: number }
}

interface LeagueOption {
  id: string
  name: string
  slug: string
}

const FIELD_LABELS: Record<string, string> = {
  discord_server_id: 'Discord server ID',
  discord_ticket_category_id: 'Ticket category ID',
  discord_steward_role_id: 'Steward role ID',
  discord_incident_channel_id: 'Incident channel ID',
  discord_transcript_channel_id: 'Transcript channel ID',
  discord_appeals_channel_id: 'Appeals channel ID',
  currency_code: 'Currency code (3 letters)',
}

const STATUS_STYLE: Record<Status, { dot: string; text: string; label: string }> = {
  done: { dot: 'bg-green-400', text: 'text-green-400', label: 'Done' },
  partial: { dot: 'bg-yellow-400', text: 'text-yellow-400', label: 'In progress' },
  todo: { dot: 'bg-rise-red', text: 'text-rise-red', label: 'To do' },
}

function SetupInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { status } = useSession()

  const [leagues, setLeagues] = useState<LeagueOption[]>([])
  const [leagueId, setLeagueId] = useState('')
  const [data, setData] = useState<SetupData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [showOptional, setShowOptional] = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Load the user's leagues
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((d) => {
        const all: LeagueOption[] = d.leagues ?? d
        setLeagues(all)
        const param = searchParams.get('league_id')
        if (param && all.some((l) => l.id === param)) setLeagueId(param)
        else if (all.length > 0) setLeagueId(all[0].id)
      })
      .catch(() => setError('Could not load your leagues'))
  }, [status, searchParams])

  const load = useCallback(async () => {
    if (!leagueId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/pitboss/admin/setup?league_id=${leagueId}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) {
        setData(null)
        setError(json.error ?? 'Failed to load setup status')
      } else {
        setData(json)
      }
    } catch {
      setError('Network error — try again')
    } finally {
      setLoading(false)
    }
  }, [leagueId])

  useEffect(() => {
    setOpenId(null)
    load()
  }, [load])

  function openCheck(check: Check) {
    if (openId === check.id) {
      setOpenId(null)
      return
    }
    setOpenId(check.id)
    setSaveMsg(null)
    if (check.fields && data) {
      const next: Record<string, string> = {}
      for (const f of check.fields) {
        const v = data.league[f]
        next[f] = v === null || v === undefined ? '' : String(v)
      }
      setDraft(next)
    }
  }

  async function save(body: Record<string, any>) {
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await fetch('/api/pitboss/admin/setup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, ...body }),
      })
      const json = await res.json()
      if (!res.ok) {
        setSaveMsg(json.error ?? 'Save failed')
        return
      }
      setSaveMsg('Saved')
      await load()
    } catch {
      setSaveMsg('Network error — try again')
    } finally {
      setSaving(false)
    }
  }

  const groups = useMemo(() => {
    if (!data) return []
    const order: string[] = []
    const map: Record<string, Check[]> = {}
    for (const c of data.checks) {
      if (!showOptional && !c.required) continue
      if (!map[c.group]) {
        map[c.group] = []
        order.push(c.group)
      }
      map[c.group].push(c)
    }
    return order.map((g) => ({ name: g, checks: map[g] }))
  }, [data, showOptional])

  function resolveHref(href: string) {
    return href
      .replace('{leagueId}', leagueId)
      .replace('{slug}', data?.league.slug ?? '')
  }

  function renderEditor(check: Check) {
    const fields = check.fields ?? []
    const league = data!.league
    const isLive = fields.includes('pitboss_status')

    return (
      <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4">
        {isLive ? (
          <>
            <div>
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                PitBoss status
              </label>
              <div className="flex gap-2">
                {['active', 'trial', 'inactive'].map((s) => (
                  <button
                    key={s}
                    disabled={saving}
                    onClick={() => save({ pitboss_status: s })}
                    className={`flex-1 rounded-xl py-2 text-xs font-bold uppercase tracking-wide ${
                      league.pitboss_status === s
                        ? 'bg-rise-red text-white'
                        : 'bg-white/5 text-white/40 border border-white/10'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                Visibility
              </label>
              <div className="flex gap-2">
                {[
                  { v: true, l: 'Public' },
                  { v: false, l: 'Private' },
                ].map((o) => (
                  <button
                    key={o.l}
                    disabled={saving}
                    onClick={() => save({ is_public: o.v })}
                    className={`flex-1 rounded-xl py-2 text-xs font-bold uppercase tracking-wide ${
                      league.is_public === o.v
                        ? 'bg-rise-red text-white'
                        : 'bg-white/5 text-white/40 border border-white/10'
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            {fields.map((f) => (
              <div key={f}>
                <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                  {FIELD_LABELS[f] ?? f}
                </label>
                <input
                  type="text"
                  inputMode={f === 'currency_code' ? 'text' : 'numeric'}
                  value={draft[f] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                  placeholder={f === 'currency_code' ? 'e.g. TRL' : 'Paste Discord ID'}
                  className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
                />
              </div>
            ))}
            <button
              disabled={saving}
              onClick={() => save(draft)}
              className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
        {saveMsg && (
          <p className={`text-xs ${saveMsg === 'Saved' ? 'text-green-400' : 'text-rise-red'}`}>{saveMsg}</p>
        )}
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button
        onClick={() => router.push(`/pitboss/admin${leagueId ? `?league_id=${leagueId}` : ''}`)}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back to Admin
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">
          League <span className="text-rise-red">Setup</span>
        </h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">PitBoss readiness checklist</p>
      </div>

      <div className="mb-6">
        <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">League</label>
        <select
          value={leagueId}
          onChange={(e) => setLeagueId(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white text-sm focus:outline-none focus:border-rise-red"
        >
          {leagues.map((l) => (
            <option key={l.id} value={l.id} className="bg-[#1A1A1A]">
              {l.name} ({l.slug})
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-xs text-rise-red">{error}</p>
        </div>
      )}

      {loading && !data && (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* Progress */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6">
            <div className="flex items-end justify-between mb-3">
              <div>
                <p className="text-3xl font-black text-white">{data.progress.percent}%</p>
                <p className="text-xs text-white/40">
                  {data.progress.requiredDone} of {data.progress.requiredTotal} required steps done
                </p>
              </div>
              <button
                onClick={load}
                disabled={loading}
                className="rounded-xl bg-white/10 border border-white/10 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-rise-red transition-all"
                style={{ width: `${data.progress.percent}%` }}
              />
            </div>
            <label className="mt-4 flex items-center gap-2 text-xs text-white/40">
              <input
                type="checkbox"
                checked={showOptional}
                onChange={(e) => setShowOptional(e.target.checked)}
              />
              Show optional steps
            </label>
          </div>

          {/* Checklist */}
          <div className="flex flex-col gap-6">
            {groups.map((g) => (
              <section key={g.name}>
                <h2 className="text-xs text-white/40 uppercase tracking-widest mb-3">{g.name}</h2>
                <div className="flex flex-col gap-3">
                  {g.checks.map((c) => {
                    const s = STATUS_STYLE[c.status]
                    const open = openId === c.id
                    const editable = !!c.fields?.length
                    return (
                      <div key={c.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <button
                          className="w-full text-left"
                          onClick={() => (editable ? openCheck(c) : setOpenId(open ? null : c.id))}
                        >
                          <div className="flex items-start gap-3">
                            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-bold text-white">{c.label}</p>
                                {!c.required && (
                                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/40">
                                    Optional
                                  </span>
                                )}
                              </div>
                              <p className={`text-xs mt-0.5 ${s.text}`}>
                                {s.label} · {c.detail}
                              </p>
                            </div>
                          </div>
                        </button>

                        {open && (
                          <>
                            <p className="mt-3 text-xs text-white/40">{c.description}</p>
                            {c.href && (
                              <button
                                onClick={() => router.push(resolveHref(c.href!))}
                                className="mt-3 w-full rounded-xl bg-white/10 border border-white/10 py-3 text-sm font-bold text-white"
                              >
                                Open →
                              </button>
                            )}
                            {editable && renderEditor(c)}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  )
}

export default function LeagueSetupPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-rise-black">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </main>
      }
    >
      <SetupInner />
    </Suspense>
  )
}
