'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

type Player = {
  id: string
  name: string
  position: string
  ovr: number | null
  dev_trait: string | null
  class_year: string | null
  status: string
}

type Franchise = {
  id: string
  name: string
  abbreviation: string | null
  logo_url: string | null
  primary_color: string | null
  secondary_color: string | null
  wins: number
  losses: number
  championships: number
  total_games: number
  win_pct: string | null
  league: { id: string; name: string; slug: string } | null
  roster: Player[]
}

type AdminRole = {
  league_id: string
  role: string
  league: { id: string; name: string; slug: string } | null
}

type ProfileData = {
  user: {
    id: string
    username: string
    discord_id: string | null
    avatar: string | null
    created_at: string
  }
  franchises: Franchise[]
  adminRoles: AdminRole[]
  stats: { totalWins: number; totalLosses: number; totalChampionships: number }
}

const DEV_TRAIT_COLORS: Record<string, string> = {
  'X-Factor': 'text-yellow-400',
  Superstar: 'text-purple-400',
  Star: 'text-blue-400',
  Normal: 'text-gray-500',
}

function getAvatarUrl(discordId: string | null, avatar: string | null) {
  if (!discordId || !avatar) return null
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`
}

function FranchiseInitials({ name, color }: { name: string; color: string }) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase()

  return (
    <div
      className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-black text-lg flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  )
}

function FranchiseCard({ franchise }: { franchise: Franchise }) {
  const accentColor = franchise.primary_color ?? '#E8284A'
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="rounded-2xl bg-gray-900 overflow-hidden border border-gray-800"
      style={{ borderLeftColor: accentColor, borderLeftWidth: 4 }}
    >
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          {franchise.logo_url ? (
            <img
              src={franchise.logo_url}
              alt={franchise.name}
              className="w-16 h-16 rounded-2xl object-contain bg-gray-800"
            />
          ) : (
            <FranchiseInitials name={franchise.name} color={accentColor} />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base leading-tight truncate">{franchise.name}</p>
            {franchise.abbreviation && (
              <p className="text-xs font-mono mt-0.5" style={{ color: accentColor }}>
                {franchise.abbreviation.trim()}
              </p>
            )}
            {franchise.league && (
              <p className="text-gray-500 text-xs mt-1">{franchise.league.name}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-center">
            <p className="text-white text-xl font-black">{franchise.wins}</p>
            <p className="text-gray-600 text-xs uppercase tracking-wider">W</p>
          </div>
          <div className="text-gray-700 text-lg font-light">—</div>
          <div className="text-center">
            <p className="text-white text-xl font-black">{franchise.losses}</p>
            <p className="text-gray-600 text-xs uppercase tracking-wider">L</p>
          </div>
          {franchise.win_pct && (
            <>
              <div className="text-gray-700 text-lg font-light">·</div>
              <div className="text-center">
                <p className="text-white text-xl font-black">{franchise.win_pct}%</p>
                <p className="text-gray-600 text-xs uppercase tracking-wider">Win%</p>
              </div>
            </>
          )}
          {franchise.championships > 0 && (
            <>
              <div className="text-gray-700 text-lg font-light">·</div>
              <div className="text-center">
                <p className="text-yellow-400 text-xl font-black">🏆 {franchise.championships}</p>
                <p className="text-gray-600 text-xs uppercase tracking-wider">Titles</p>
              </div>
            </>
          )}
          {franchise.total_games === 0 && (
            <p className="text-gray-600 text-xs ml-2">No games played</p>
          )}
        </div>
      </div>

      {franchise.roster.length > 0 && (
        <>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="w-full px-4 py-2.5 text-xs text-gray-500 border-t border-gray-800 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
          >
            <span>Top {franchise.roster.length} Players</span>
            <span className="text-gray-600">{expanded ? '▲' : '▼'}</span>
          </button>

          {expanded && (
            <div className="px-4 pb-4 space-y-2">
              {franchise.roster.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <span className="text-gray-600 text-xs font-mono w-6 text-right">{p.ovr ?? '—'}</span>
                  <span
                    className="text-xs font-bold px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
                  >
                    {p.position}
                  </span>
                  <span className="text-white text-sm flex-1 truncate">{p.name}</span>
                  {p.dev_trait && p.dev_trait !== 'Normal' && (
                    <span className={`text-xs ${DEV_TRAIT_COLORS[p.dev_trait] ?? 'text-gray-500'}`}>
                      {p.dev_trait === 'X-Factor' ? '⚡' : p.dev_trait === 'Superstar' ? '★' : '◆'}
                    </span>
                  )}
                  {p.class_year && (
                    <span className="text-gray-600 text-xs">{p.class_year}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {franchise.roster.length === 0 && (
        <div className="px-4 pb-4 border-t border-gray-800 pt-3">
          <p className="text-gray-700 text-xs">No roster assigned yet</p>
        </div>
      )}
    </div>
  )
}

export default function GMProfilePage() {
  const params = useParams()
  const router = useRouter()
  const { status } = useSession()
  const userId = params.id as string

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
    if (status === 'authenticated') loadProfile()
  }, [status])

  async function loadProfile() {
    setLoading(true)
    try {
      const res = await fetch(`/api/rise/gm/${userId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load profile')
      setProfile(json)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading profile…</p>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-[#E8284A] text-center">{error || 'Profile not found'}</p>
        <button onClick={() => router.back()} className="text-gray-400 underline text-sm">Go back</button>
      </div>
    )
  }

  const { user, franchises, adminRoles, stats } = profile
  const avatarUrl = getAvatarUrl(user.discord_id, user.avatar)
  const memberSince = new Date(user.created_at).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric',
  })

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">
      <div className="px-4 pt-12 pb-6 border-b border-gray-800">
        <button onClick={() => router.back()} className="text-white/50 text-sm mb-4 block">← Back</button>

        <div className="flex items-center gap-4 mb-5">
          {avatarUrl ? (
            <img src={avatarUrl} alt={user.username} className="w-16 h-16 rounded-2xl object-cover" />
          ) : (
            <div className="w-16 h-16 rounded-2xl bg-gray-800 flex items-center justify-center">
              <span className="text-gray-500 text-2xl font-black">{user.username[0].toUpperCase()}</span>
            </div>
          )}
          <div>
            <h1 className="text-white font-bold text-xl leading-tight">{user.username}</h1>
            <p className="text-gray-500 text-sm mt-0.5">GM · Member since {memberSince}</p>
            {adminRoles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {adminRoles.map((r, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-[#E8284A]/10 text-[#E8284A] capitalize">
                    {r.role.replace(/_/g, ' ')} · {r.league?.name ?? ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {franchises.length > 1 && (
          <div className="flex gap-6">
            <div className="text-center">
              <p className="text-white text-2xl font-black">{stats.totalWins}</p>
              <p className="text-gray-600 text-xs uppercase tracking-wider">Career W</p>
            </div>
            <div className="text-center">
              <p className="text-white text-2xl font-black">{stats.totalLosses}</p>
              <p className="text-gray-600 text-xs uppercase tracking-wider">Career L</p>
            </div>
            {stats.totalChampionships > 0 && (
              <div className="text-center">
                <p className="text-yellow-400 text-2xl font-black">{stats.totalChampionships}</p>
                <p className="text-gray-600 text-xs uppercase tracking-wider">Titles</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pt-5 space-y-4">
        {franchises.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-600 text-base">No franchises assigned yet</p>
            <p className="text-gray-700 text-sm mt-1">This GM hasn't been assigned a franchise in any dynasty league.</p>
          </div>
        ) : (
          <>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">
              {franchises.length === 1 ? 'Franchise' : `${franchises.length} Franchises`}
            </p>
            {franchises.map((f) => (
              <FranchiseCard key={f.id} franchise={f} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
