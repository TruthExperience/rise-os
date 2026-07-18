'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface AppealRow {
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
  reviewed_by: string | null
  reviewed_at: string | null
  review_notes: string | null
  created_at: string
  incident: {
    id: string
    incident_type: string
    description: string
    season: string | null
    round: number | null
    lap: number | null
  } | null
  league: { id: string; name: string; slug: string } | null
  appellant: { id: string; discord_username: string; display_name: string | null; discord_avatar: string | null } | null
  reviewer: { id: string; discord_username: string; display_name: string | null } | null
}

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'upheld', label: 'Upheld' },
  { key: 'overturned', label: 'Overturned' },
  { key: 'dismissed', label: 'Dismissed' },
] as const

const APPEAL_STATUS_STYLES: Record<string, string> = {
  open:       'border-yellow-400/30 text-yellow-400 bg-yellow-400/10',
  overturned: 'border-blue-400/30 text-blue-400 bg-blue-400/10',
  upheld:     'border-green-400/30 text-green-400 bg-green-400/10',
  dismissed:  'border-white/20 text-white/50 bg-white/5',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function AppealsPageInner() {
  const { status: sessionStatus } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()

  const initialTab = (searchParams.get('status') as (typeof STATUS_TABS)[number]['key']) || 'all'

  const [appeals, setAppeals]     = useState<AppealRow[]>([])
  const [isSteward, setIsSteward] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [activeTab, setActiveTab] = useState<(typeof STATUS_TABS)[number]['key']>(initialTab)

  useEffect(() => {
    if (sessionStatus === 'unauthenticated') router.push('/login')
  }, [sessionStatus, router])

  useEffect(() => {
    if (sessionStatus === 'authenticated') fetchAppeals(activeTab)
  }, [sessionStatus, activeTab])

  async function fetchAppeals(tab: string) {
    setLoading(true)
    setError('')
    try {
      const qs = tab !== 'all' ? `?status=${tab}` : ''
      const res = await fetch(`/api/pitboss/appeals${qs}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load appeals')
        return
      }
      setAppeals(data.appeals ?? [])
      setIsSteward(!!data.isStewardAnywhere)
    } catch (e) {
      console.error(e)
      setError('Failed to load appeals')
    } finally {
      setLoading(false)
    }
  }

  function selectTab(tab: (typeof STATUS_TABS)[number]['key']) {
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'all') params.delete('status')
    else params.set('status', tab)
    router.replace(`/pitboss/appeals?${params.toString()}`)
  }

  if (sessionStatus === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">Appeals</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {isSteward ? 'All appeals you steward, plus your own' : 'Appeals you have filed'}
        </p>
      </div>

      {/* Status tabs */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-1 -mx-4 px-4">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => selectTab(tab.key)}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${
              activeTab === tab.key
                ? 'bg-rise-red text-white'
                : 'bg-white/5 text-white/40 border border-white/10'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-3 mb-4">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {appeals.length === 0 && !error ? (
        <div className="bg-white/5 rounded-2xl px-4 py-10 text-center">
          <p className="text-white/30 text-sm">No appeals here.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {appeals.map((appeal) => (
            <button
              key={appeal.id}
              onClick={() => router.push(`/pitboss/incidents/${appeal.incident_id}`)}
              className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <p className="text-white font-bold text-sm truncate">
                    {appeal.incident?.incident_type ?? 'Incident'}
                  </p>
                  <p className="text-white/30 text-xs mt-0.5 truncate">
                    {appeal.league?.name ?? 'Unknown league'}
                  </p>
                </div>
                <span
                  className={`flex-shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${
                    APPEAL_STATUS_STYLES[appeal.status] ?? 'border-white/20 text-white/50 bg-white/5'
                  }`}
                >
                  {appeal.status}
                </span>
              </div>

              <p className="text-white/50 text-xs line-clamp-2 mb-3">{appeal.reason}</p>

              <div className="flex items-center justify-between text-[10px] text-white/30 uppercase tracking-widest">
                <span>
                  Filed by {appeal.appellant?.display_name ?? appeal.appellant?.discord_username ?? 'Unknown'}
                </span>
                <span>{formatDate(appeal.created_at)}</span>
              </div>

              {appeal.status !== 'open' && appeal.reviewed_at && (
                <div className="mt-2 pt-2 border-t border-white/5 text-[10px] text-white/30 uppercase tracking-widest">
                  Reviewed by {appeal.reviewer?.display_name ?? appeal.reviewer?.discord_username ?? 'Unknown'} · {formatDate(appeal.reviewed_at)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </main>
  )
}
