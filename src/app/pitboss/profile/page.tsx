'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface Driver {
  id: string
  discord_username: string
  discord_avatar: string | null
  display_name: string | null
  tier: string | null
  pp_total: number
  super_licence_status: string
  created_at: string
}

interface League {
  id: string
  role: string
  certified: boolean
  certified_at: string | null
  joined_at: string
  league_id: string
  league: { name: string; slug: string } | null
}

interface Licence {
  id: string
  licence_number: string
  role_code: string
  title: string
  tier: string | null
  status: string
  issued_at: string
  expires_at: string | null
  league_id: string
}

interface Penalty {
  id: string
  points: number
  reason: string
  issued_at: string
  expires_at: string | null
  league_id: string
}

interface Certification {
  id: string
  league_id: string
  status: string
  score: number | null
  pass_mark: number
  attempt_number: number
  completed_at: string | null
}

interface ProfileData {
  driver: Driver
  leagues: League[]
  licences: Licence[]
  penalties: Penalty[]
  certifications: Certification[]
}

const STATUS_COLORS: Record<string, string> = {
  active:    'text-green-400 bg-green-500/20',
  suspended: 'text-yellow-400 bg-yellow-500/20',
  revoked:   'text-red-400 bg-red-500/20',
  passed:    'text-green-400 bg-green-500/20',
  failed:    'text-red-400 bg-red-500/20',
  pending:   'text-white/50 bg-white/10',
}

export default function ProfilePage() {
  const router = useRouter()
  const { status } = useSession()
  const [profile, setProfile]   = useState<ProfileData | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/pitboss/profile')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setProfile(data)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [status])

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  if (error) {
    return (
      <main className="min-h-screen bg-rise-black px-4 py-8">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-6">← Back</button>
        <div className="rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      </main>
    )
  }

  if (!profile) return null

  const { driver, leagues, licences, penalties, certifications } = profile
  const activeLicences = licences.filter((l) => l.status === 'active')
  const totalPP = penalties.reduce((sum, p) => sum + p.points, 0)

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Header */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      {/* Identity Card */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">
        <div className="flex items-center gap-4">
          {driver.discord_avatar ? (
            <img
              src={`https://cdn.discordapp.com/avatars/${driver.discord_id}/${driver.discord_avatar}.png`}
              alt="avatar"
              className="h-16 w-16 rounded-full border-2 border-rise-red"
            />
          ) : (
            <div className="h-16 w-16 rounded-full border-2 border-rise-red bg-white/10 flex items-center justify-center">
              <span className="text-white/40 text-xl">?</span>
            </div>
          )}
          <div className="flex-1">
            <p className="text-white font-bold text-lg">
              {driver.display_name || driver.discord_username}
            </p>
            <p className="text-white/40 text-xs">@{driver.discord_username}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_COLORS[driver.super_licence_status] ?? 'text-white/50 bg-white/10'}`}>
                {driver.super_licence_status}
              </span>
              {driver.tier && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase text-white/50 bg-white/10">
                  {driver.tier}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3 mt-5 pt-5 border-t border-white/10">
          <div className="text-center">
            <p className="text-white font-bold text-xl">{leagues.length}</p>
            <p className="text-white/30 text-[10px] uppercase tracking-wide mt-0.5">Leagues</p>
          </div>
          <div className="text-center">
            <p className="text-white font-bold text-xl">{activeLicences.length}</p>
            <p className="text-white/30 text-[10px] uppercase tracking-wide mt-0.5">Licences</p>
          </div>
          <div className="text-center">
            <p className={`font-bold text-xl ${totalPP > 0 ? 'text-rise-red' : 'text-white'}`}>{totalPP}</p>
            <p className="text-white/30 text-[10px] uppercase tracking-wide mt-0.5">Penalty Pts</p>
          </div>
        </div>
      </div>

      {/* Licences */}
      {activeLicences.length > 0 && (
        <section className="mb-6">
          <p className="text-white/30 text-xs uppercase tracking-widest mb-3">Licences</p>
          <div className="flex flex-col gap-3">
            {activeLicences.map((lic) => (
              <div key={lic.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-bold text-sm">{lic.title}</p>
                    <p className="text-white/40 text-xs mt-0.5">{lic.licence_number}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS_COLORS[lic.status] ?? 'text-white/50 bg-white/10'}`}>
                    {lic.status}
                  </span>
                </div>
                <p className="text-white/20 text-[10px] mt-2">
                  Issued {new Date(lic.issued_at).toLocaleDateString()}
                  {lic.expires_at && ` · Expires ${new Date(lic.expires_at).toLocaleDateString()}`}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* League Memberships */}
      {leagues.length > 0 && (
        <section className="mb-6">
          <p className="text-white/30 text-xs uppercase tracking-widest mb-3">League Memberships</p>
          <div className="flex flex-col gap-3">
            {leagues.map((l) => (
              <div key={l.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-bold text-sm">{l.league?.name ?? l.league_id}</p>
                    <p className="text-white/40 text-xs mt-0.5 uppercase">{l.role}</p>
                  </div>
                  {l.certified && (
                    <span className="rounded-full px-3 py-1 text-xs font-bold text-green-400 bg-green-500/20">
                      Certified ✓
                    </span>
                  )}
                </div>
                <p className="text-white/20 text-[10px] mt-2">
                  Joined {new Date(l.joined_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Certifications */}
      {certifications.length > 0 && (
        <section className="mb-6">
          <p className="text-white/30 text-xs uppercase tracking-widest mb-3">Certification History</p>
          <div className="flex flex-col gap-3">
            {certifications.map((cert) => (
              <div key={cert.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-bold">Attempt #{cert.attempt_number}</p>
                    <p className="text-white/40 text-xs mt-0.5">
                      {cert.score != null ? `Score: ${cert.score}% · Pass mark: ${cert.pass_mark}%` : `Pass mark: ${cert.pass_mark}%`}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS_COLORS[cert.status] ?? 'text-white/50 bg-white/10'}`}>
                    {cert.status}
                  </span>
                </div>
                {cert.completed_at && (
                  <p className="text-white/20 text-[10px] mt-2">
                    {new Date(cert.completed_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Penalty Ledger */}
      {penalties.length > 0 && (
        <section className="mb-6">
          <p className="text-white/30 text-xs uppercase tracking-widest mb-3">Penalty Ledger</p>
          <div className="flex flex-col gap-3">
            {penalties.map((p) => (
              <div key={p.id} className="rounded-xl border border-rise-red/20 bg-rise-red/5 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-white text-sm">{p.reason}</p>
                  <span className="text-rise-red font-bold text-sm">+{p.points}pp</span>
                </div>
                <p className="text-white/20 text-[10px] mt-2">
                  {new Date(p.issued_at).toLocaleDateString()}
                  {p.expires_at && ` · Expires ${new Date(p.expires_at).toLocaleDateString()}`}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-center text-xs text-white/20 mt-6 mb-2">
        Member since {new Date(driver.created_at).toLocaleDateString()}
      </p>
    </main>
  )
}
