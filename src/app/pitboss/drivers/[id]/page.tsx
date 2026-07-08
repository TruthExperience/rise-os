'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import DriverCareerCard from '@/components/pitboss/DriverCareerCard'

interface Driver {
  id: string
  discord_id: string
  discord_username: string
  discord_avatar: string | null
  display_name: string | null
  tier: string
  pp_total: number
  super_licence_status: string
  era_endorsements: string[]
}

interface LeagueMembership {
  role: string
  certified: boolean
  certified_at: string | null
  joined_at: string | null
  league_id: string
  league: { id: string; name: string; slug: string; sport: string; logo_url: string | null } | null
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

interface Certification {
  id: string
  league_id: string
  role_code: string
  status: string
  score: number | null
  pass_mark: number
  attempt_number: number
  completed_at: string | null
  locked_until: string | null
}

interface Contract {
  id: string
  contract_class: string
  season_start: string | null
  season_end: string | null
  base_salary_per_season: any
  signing_bonus: number | null
  status: string
  special_conditions: string | null
  league_id: string
  franchise: {
    id: string
    name: string
    abbreviation: string | null
    primary_color: string | null
    secondary_color: string | null
    logo_url: string | null
  } | null
}

interface ResultsSummary {
  races: number
  wins: number
  podiums: number
  dnfs: number
  fastest_laps: number
  total_points: number
  recent: any[]
}

interface Penalty {
  id: string
  points: number
  reason: string
  issued_at: string
  expires_at: string | null
  league_id: string
}

interface ProfileData {
  driver: Driver
  leagues: LeagueMembership[]
  licences: Licence[]
  certifications: Certification[]
  contracts: Contract[]
  results: ResultsSummary
  penalties: Penalty[]
}

function avatarUrl(driver: Driver) {
  if (driver.discord_avatar) {
    return `https://cdn.discordapp.com/avatars/${driver.discord_id}/${driver.discord_avatar}.png?size=128`
  }
  return null
}

function tierColor(tier: string) {
  const map: Record<string, string> = {
    T1: '#FFD700', T2: '#C0C0C0', T3: '#CD7F32',
    elite: '#E8284A', apex_pro: '#9B59B6', apex: '#3498DB',
    academy: '#2ECC71', staff: '#95A5A6',
  }
  return map[tier] ?? '#E8284A'
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    passed: 'text-green-400', active: 'text-green-400',
    failed: 'text-red-400', suspended: 'text-red-400', revoked: 'text-red-400',
    in_progress: 'text-yellow-400', pending: 'text-yellow-400',
    expired: 'text-gray-500',
  }
  return map[status] ?? 'text-gray-400'
}

function statusDot(status: string) {
  const map: Record<string, string> = {
    passed: 'bg-green-400', active: 'bg-green-400',
    failed: 'bg-red-400', suspended: 'bg-red-400', revoked: 'bg-red-400',
    in_progress: 'bg-yellow-400', pending: 'bg-yellow-400',
    expired: 'bg-gray-500',
  }
  return map[status] ?? 'bg-gray-400'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatSalary(val: any) {
  if (!val) return '—'
  if (typeof val === 'object' && val.amount) return `${val.currency ?? 'AWC$'}${Number(val.amount).toLocaleString()}`
  return String(val)
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-white font-bold text-base uppercase tracking-widest">{title}</h2>
      {count !== undefined && (
        <span className="bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded-full">{count}</span>
      )}
    </div>
  )
}

export default function DriverProfilePage() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const leagueFilter = searchParams.get('league')
  const router = useRouter()
  const { data: session } = useSession()

  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'licences' | 'certs' | 'contract' | 'stats' | 'career' | 'penalties'>('overview')

  const isOwnProfile = session?.user?.id === id

  useEffect(() => {
    loadProfile()
  }, [id, leagueFilter])

  async function loadProfile() {
    setLoading(true)
    try {
      const url = `/api/pitboss/drivers/${id}/profile${leagueFilter ? `?league=${leagueFilter}` : ''}`
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load profile')
      setProfile(data)
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
        <p className="text-[#E8284A] text-center">{error || 'Driver not found'}</p>
        <button onClick={() => router.back()} className="text-gray-400 underline text-sm">Go back</button>
      </div>
    )
  }

  const { driver, leagues, licences, certifications, contracts, results, penalties } = profile

  const primaryFranchise = contracts[0]?.franchise
  const bannerColor = primaryFranchise?.primary_color ?? '#E8284A'
  const bannerSecondary = primaryFranchise?.secondary_color ?? '#1A1A1A'
  const avatar = avatarUrl(driver)
  const displayName = driver.display_name ?? driver.discord_username

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'licences', label: 'Licences' },
    { key: 'certs', label: 'Certs' },
    { key: 'contract', label: 'Contract' },
    { key: 'stats', label: 'Stats' },
    { key: 'career', label: 'Career' },
    { key: 'penalties', label: 'Penalties' },
  ] as const

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">

      {/* Banner */}
      <div
        className="relative w-full pt-12 pb-6 px-4"
        style={{
          background: `linear-gradient(135deg, ${bannerColor}33 0%, ${bannerSecondary}99 60%, #1A1A1A 100%)`,
          borderBottom: `2px solid ${bannerColor}55`,
        }}
      >
        <button
          onClick={() => router.back()}
          className="absolute top-4 left-4 text-white/60 text-sm"
        >
          ← Back
        </button>

        {leagueFilter && (
          <div className="absolute top-4 right-4 flex items-center gap-2">
            <span className="text-xs text-white/50 bg-white/10 px-2 py-1 rounded-full">
              {leagueFilter.toUpperCase()}
            </span>
            <button
              onClick={() => router.push(`/pitboss/drivers/${id}`)}
              className="text-xs text-white/40 underline"
            >
              Clear
            </button>
          </div>
        )}

        <div className="flex items-end gap-4 mt-6">
          <div
            className="w-20 h-20 rounded-2xl overflow-hidden border-2 flex-shrink-0"
            style={{ borderColor: bannerColor }}
          >
            {avatar ? (
              <img src={avatar} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              <div
                className="w-full h-full flex items-center justify-center text-2xl font-bold text-white"
                style={{ background: bannerColor + '44' }}
              >
                {displayName[0].toUpperCase()}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-xl leading-tight truncate">{displayName}</h1>
            <p className="text-white/50 text-sm truncate">@{driver.discord_username}</p>

            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span
                className="text-xs font-bold px-2 py-0.5 rounded-full"
                style={{ background: tierColor(driver.tier) + '33', color: tierColor(driver.tier), border: `1px solid ${tierColor(driver.tier)}55` }}
              >
                {driver.tier.toUpperCase()}
              </span>

              <span className={`text-xs flex items-center gap-1 ${statusColor(driver.super_licence_status)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot(driver.super_licence_status)}`} />
                {driver.super_licence_status.replace('_', ' ')}
              </span>

              {driver.pp_total > 0 && (
                <span className="text-xs text-orange-400 font-semibold">
                  {driver.pp_total} PP
                </span>
              )}
            </div>
          </div>
        </div>

        {primaryFranchise && (
          <div className="mt-3 flex items-center gap-2">
            {primaryFranchise.logo_url && (
              <img src={primaryFranchise.logo_url} alt={primaryFranchise.name} className="w-5 h-5 object-contain" />
            )}
            <span className="text-white/60 text-sm">{primaryFranchise.name}</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex overflow-x-auto scrollbar-hide border-b border-gray-800 px-2 sticky top-0 bg-[#1A1A1A] z-10">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-shrink-0 px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-[#E8284A] text-white'
                : 'border-transparent text-gray-500'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="px-4 pt-5 space-y-6">

        {/* OVERVIEW */}
        {activeTab === 'overview' && (
          <>
            <div>
              <SectionHeader title="Leagues" count={leagues.length} />
              {leagues.length === 0 ? (
                <p className="text-gray-600 text-sm">No league memberships.</p>
              ) : (
                <div className="space-y-2">
                  {leagues.map((m) => (
                    <div key={m.league_id} className="bg-gray-900 rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold text-sm">{m.league?.name ?? 'Unknown League'}</p>
                        <p className="text-gray-500 text-xs capitalize">{m.role} · Joined {formatDate(m.joined_at)}</p>
                      </div>
                      {m.certified && (
                        <span className="text-green-400 text-xs font-semibold bg-green-400/10 px-2 py-0.5 rounded-full">
                          ✓ Certified
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <SectionHeader title="Career at a Glance" />
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Races', value: results.races },
                  { label: 'Wins', value: results.wins },
                  { label: 'Podiums', value: results.podiums },
                  { label: 'DNFs', value: results.dnfs },
                  { label: 'Fastest Laps', value: results.fastest_laps },
                  { label: 'Points', value: results.total_points },
                ].map((stat) => (
                  <div key={stat.label} className="bg-gray-900 rounded-xl p-3 text-center">
                    <p className="text-white font-bold text-lg">{stat.value}</p>
                    <p className="text-gray-500 text-xs">{stat.label}</p>
                  </div>
                ))}
              </div>
            </div>

            {driver.era_endorsements?.length > 0 && (
              <div>
                <SectionHeader title="Era Endorsements" />
                <div className="flex flex-wrap gap-2">
                  {driver.era_endorsements.map((e) => (
                    <span key={e} className="text-xs bg-[#E8284A]/15 text-[#E8284A] border border-[#E8284A]/30 px-3 py-1 rounded-full">
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* LICENCES */}
        {activeTab === 'licences' && (
          <div>
            <SectionHeader title="Licences" count={licences.length} />
            {licences.length === 0 ? (
              <p className="text-gray-600 text-sm">No licences issued.</p>
            ) : (
              <div className="space-y-3">
                {licences.map((lic) => (
                  <div key={lic.id} className="bg-gray-900 rounded-xl px-4 py-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white font-bold text-sm">{lic.title}</p>
                        <p className="text-gray-500 text-xs font-mono mt-0.5">{lic.licence_number}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${statusDot(lic.status)}`} />
                        <span className={`text-xs capitalize ${statusColor(lic.status)}`}>{lic.status}</span>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{lic.role_code}</span>
                      {lic.tier && <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{lic.tier}</span>}
                      <span className="text-xs text-gray-600">Issued {formatDate(lic.issued_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CERTIFICATIONS */}
        {activeTab === 'certs' && (
          <div>
            <SectionHeader title="Certifications" count={certifications.length} />
            {certifications.length === 0 ? (
              <p className="text-gray-600 text-sm">No certification history.</p>
            ) : (
              <div className="space-y-3">
                {certifications.map((cert) => (
                  <div key={cert.id} className="bg-gray-900 rounded-xl px-4 py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold text-sm">{cert.role_code} Certification</p>
                        <p className="text-gray-500 text-xs">Attempt #{cert.attempt_number} · {formatDate(cert.completed_at)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${statusColor(cert.status)}`}>
                          {cert.status.toUpperCase()}
                        </p>
                        {cert.score !== null && (
                          <p className="text-gray-500 text-xs">{cert.score}% / {cert.pass_mark}%</p>
                        )}
                      </div>
                    </div>
                    {cert.locked_until && new Date(cert.locked_until) > new Date() && (
                      <p className="text-orange-400 text-xs mt-2">
                        🔒 Locked until {formatDate(cert.locked_until)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CONTRACT */}
        {activeTab === 'contract' && (
          <div>
            <SectionHeader title="Active Contracts" count={contracts.length} />
            {contracts.length === 0 ? (
              <p className="text-gray-600 text-sm">No active contracts.</p>
            ) : (
              <div className="space-y-4">
                {contracts.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-xl overflow-hidden border border-gray-800"
                    style={c.franchise?.primary_color ? { borderColor: c.franchise.primary_color + '44' } : {}}
                  >
                    <div
                      className="px-4 py-3 flex items-center gap-3"
                      style={{
                        background: c.franchise?.primary_color
                          ? `linear-gradient(90deg, ${c.franchise.primary_color}33, transparent)`
                          : '#111',
                      }}
                    >
                      {c.franchise?.logo_url && (
                        <img src={c.franchise.logo_url} alt={c.franchise.name} className="w-8 h-8 object-contain" />
                      )}
                      <div>
                        <p className="text-white font-bold text-sm">{c.franchise?.name ?? 'Unknown Team'}</p>
                        <p className="text-gray-400 text-xs">{c.contract_class} Contract</p>
                      </div>
                    </div>

                    <div className="bg-gray-900 px-4 py-3 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Duration</span>
                        <span className="text-white">{c.season_start ?? '—'} → {c.season_end ?? '—'}</span>
                      </div>

                      {isOwnProfile ? (
                        <>
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Base Salary</span>
                            <span className="text-white font-semibold">{formatSalary(c.base_salary_per_season)}</span>
                          </div>
                          {c.signing_bonus && (
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-500">Signing Bonus</span>
                              <span className="text-green-400 font-semibold">+{Number(c.signing_bonus).toLocaleString()}</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Salary</span>
                          <span className="text-gray-600 italic">Confidential</span>
                        </div>
                      )}

                      {c.special_conditions && (
                        <div className="pt-1 border-t border-gray-800">
                          <p className="text-gray-500 text-xs">Special conditions:</p>
                          <p className="text-gray-400 text-xs mt-0.5">{c.special_conditions}</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* STATS */}
        {activeTab === 'stats' && (
          <div className="space-y-4">
            <SectionHeader title="Race Statistics" />
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Total Races', value: results.races, color: 'text-white' },
                { label: 'Wins', value: results.wins, color: 'text-yellow-400' },
                { label: 'Podiums', value: results.podiums, color: 'text-orange-400' },
                { label: 'DNFs', value: results.dnfs, color: 'text-red-400' },
                { label: 'Fastest Laps', value: results.fastest_laps, color: 'text-purple-400' },
                { label: 'Total Points', value: results.total_points, color: 'text-[#E8284A]' },
              ].map((s) => (
                <div key={s.label} className="bg-gray-900 rounded-xl p-4">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-gray-500 text-xs mt-1">{s.label}</p>
                </div>
              ))}
            </div>

            {results.recent.length > 0 && (
              <>
                <SectionHeader title="Recent Results" />
                <div className="space-y-2">
                  {results.recent.map((r: any, i: number) => (
                    <div key={i} className="bg-gray-900 rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm">{r.track ?? `Round ${r.round}`}</p>
                        <p className="text-gray-500 text-xs">Season {r.season}</p>
                      </div>
                      <div className="text-right">
                        {r.dnf ? (
                          <span className="text-red-400 font-bold text-sm">DNF</span>
                        ) : (
                          <span className="text-white font-bold text-sm">P{r.finish_position}</span>
                        )}
                        {r.fastest_lap && <p className="text-purple-400 text-xs">⚡ FL</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* CAREER (wins/top3/top5/top10 + teams driven for) */}
        {activeTab === 'career' && (
          <DriverCareerCard driverId={id} />
        )}

        {/* PENALTIES */}
        {activeTab === 'penalties' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <SectionHeader title="Penalty Points" />
              <span className={`text-lg font-bold ${driver.pp_total > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                {driver.pp_total} PP Total
              </span>
            </div>

            {penalties.length === 0 ? (
              <p className="text-gray-600 text-sm">No penalty history. Clean record ✓</p>
            ) : (
              <div className="space-y-2">
                {penalties.map((p) => (
                  <div key={p.id} className="bg-gray-900 rounded-xl px-4 py-3">
                    <div className="flex items-start justify-between">
                      <p className="text-white text-sm flex-1 pr-3">{p.reason}</p>
                      <span className="text-orange-400 font-bold text-sm flex-shrink-0">+{p.points} PP</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <p className="text-gray-600 text-xs">{formatDate(p.issued_at)}</p>
                      {p.expires_at && (
                        <p className="text-gray-600 text-xs">Expires {formatDate(p.expires_at)}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
