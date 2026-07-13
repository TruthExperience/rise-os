'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface RosterDriver {
  id: string
  discord_id: string
  display_name: string | null
  discord_username: string
  discord_avatar: string | null
  tier: string
  pp_total: number
  super_licence_status: string
}

interface RosterEntry {
  contractId: string
  contractClass: string
  seasonStart: string | null
  seasonEnd: string | null
  driver: RosterDriver
}

function tierColor(tier: string) {
  const map: Record<string, string> = {
    elite: '#E8284A',
    apex_pro: '#9B59B6',
    apex: '#3498DB',
    academy: '#2ECC71',
  }
  return map[tier] ?? '#E8284A'
}

function statusDot(status: string) {
  const map: Record<string, string> = {
    active: 'bg-green-400',
    review: 'bg-yellow-400',
    suspended: 'bg-red-400',
    revoked: 'bg-red-400',
  }
  return map[status] ?? 'bg-gray-500'
}

export default function PitbossFranchiseDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const { leagueId, franchiseId } = useParams<{ leagueId: string; franchiseId: string }>()

  const [franchise, setFranchise] = useState<any>(null)
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [rosterLoading, setRosterLoading] = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (!franchiseId) return
    fetchFranchise()
    fetchRoster()
  }, [franchiseId])

  async function fetchFranchise() {
    setLoading(true)
    try {
      const res = await fetch(`/api/franchises/${leagueId}/${franchiseId}`)
      if (res.ok) setFranchise(await res.json())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  async function fetchRoster() {
    setRosterLoading(true)
    try {
      const res = await fetch(`/api/pitboss/franchises/${leagueId}/${franchiseId}/roster`)
      if (res.ok) {
        const data = await res.json()
        setRoster(data.roster ?? [])
      }
    } catch (e) {
      console.error(e)
    } finally {
      setRosterLoading(false)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  if (!franchise) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <p className="text-white/40">Franchise not found.</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="flex items-center gap-2 text-white/40 text-sm mb-6">
        ← Back
      </button>

      <div className="flex flex-col items-center mb-8">
        {franchise.logo_url ? (
          <img src={franchise.logo_url} alt={franchise.name} className="w-24 h-24 rounded-2xl object-cover border border-white/10 mb-4" />
        ) : (
          <div className="w-24 h-24 rounded-2xl border border-white/10 flex items-center justify-center mb-4"
            style={{ backgroundColor: franchise.primary_color ?? '#ffffff20' }}>
            <span className="text-white font-black text-2xl">
              {franchise.abbreviation ?? franchise.name.slice(0, 3).toUpperCase()}
            </span>
          </div>
        )}
        <h1 className="text-2xl font-black text-white text-center">{franchise.name}</h1>
        {franchise.abbreviation && (
          <p className="text-white/30 text-xs uppercase tracking-widest mt-1">{franchise.abbreviation}</p>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <p className="text-white/30 text-xs uppercase tracking-widest mb-4">
          Roster {roster.length > 0 && `(${roster.length})`}
        </p>

        {rosterLoading ? (
          <div className="flex justify-center py-6">
            <div className="h-6 w-6 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
          </div>
        ) : roster.length === 0 ? (
          <p className="text-white/30 text-sm text-center py-6">No drivers under contract.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {roster.map((entry) => {
              const d = entry.driver
              const name = d.display_name ?? d.discord_username
              return (
                <button
                  key={entry.contractId}
                  onClick={() => router.push(`/pitboss/drivers/${d.id}`)}
                  className="flex items-center justify-between border-b border-white/5 pb-3 last:border-b-0 last:pb-0 text-left w-full active:opacity-60 transition-opacity"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {d.discord_avatar ? (
                      <img
                        src={`https://cdn.discordapp.com/avatars/${d.discord_id}/${d.discord_avatar}.png?size=64`}
                        alt={name}
                        className="w-9 h-9 rounded-lg object-cover border border-white/10 flex-shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                        <span className="text-white/50 text-xs font-black">{name[0]?.toUpperCase()}</span>
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-white text-sm font-semibold truncate">{name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                          style={{ background: tierColor(d.tier) + '33', color: tierColor(d.tier) }}
                        >
                          {d.tier.toUpperCase()}
                        </span>
                        <span className={`w-1.5 h-1.5 rounded-full ${statusDot(d.super_licence_status)}`} />
                        <span className="text-white/30 text-[10px]">{entry.contractClass}</span>
                      </div>
                    </div>
                  </div>
                  {d.pp_total > 0 && (
                    <span className="text-orange-400 font-black text-sm flex-shrink-0 ml-2">{d.pp_total} PP</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
