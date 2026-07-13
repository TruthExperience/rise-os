'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface League {
  id: string
  name: string
  slug: string
  pitboss_status: string
}

interface RoleRequirement {
  role_code: string
  role_name: string
  question_count: number
  pass_mark: number
  description: string
  status?: string
  attempt_number?: number
  locked_until?: string | null
  certification_id?: string | null
}

export default function CertPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preselectLeagueId = searchParams.get('league')
  const { status } = useSession()
  const [leagues, setLeagues]               = useState<League[]>([])
  const [selectedLeague, setSelectedLeague] = useState<League | null>(null)
  const [roles, setRoles]                   = useState<RoleRequirement[]>([])
  const [loadingRoles, setLoadingRoles]     = useState(false)
  const [starting, setStarting]             = useState<string | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [loading, setLoading]               = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  // Load leagues
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const active = (data.leagues ?? data).filter(
          (l: League) =>
            l.pitboss_status === 'active' || l.pitboss_status === 'trial'
        )
        setLeagues(active)
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  // If a league was passed in via ?league=, auto-select it once the
  // leagues list has loaded, so deep links skip straight to role selection.
  useEffect(() => {
    if (!preselectLeagueId || leagues.length === 0 || selectedLeague) return
    const match = leagues.find((l) => l.id === preselectLeagueId)
    if (match) selectLeague(match)
  }, [preselectLeagueId, leagues])

  // Load roles + cert status when a league is selected
  async function selectLeague(league: League) {
    setSelectedLeague(league)
    setRoles([])
    setError(null)
    setLoadingRoles(true)
    try {
      const [reqRes, statusRes] = await Promise.all([
        fetch(`/api/pitboss/cert/requirements?league_id=${league.id}`),
        fetch(`/api/pitboss/cert/status?league_id=${league.id}`),
      ])

      const reqData    = await reqRes.json()
      const statusData = await statusRes.json()

      if (!reqRes.ok) throw new Error(reqData.error ?? 'Failed to load roles')

      const requirements: RoleRequirement[] = reqData.requirements ?? []

      // Merge cert status into each role
      const enriched = requirements.map((role) => ({
        ...role,
        status:           statusData.status ?? 'eligible',
        attempt_number:   statusData.attempt_number ?? 0,
        locked_until:     statusData.locked_until ?? null,
        certification_id: statusData.certification_id ?? null,
      }))

      setRoles(enriched)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load roles')
    } finally {
      setLoadingRoles(false)
    }
  }

  async function handleStart(leagueId: string, roleCode: string) {
    setStarting(roleCode)
    setError(null)
    try {
      const res = await fetch('/api/pitboss/cert/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, role_code: roleCode }),
      })
      const data = await res.json()

      if (!res.ok) {
        if (res.status === 409 && data.certification_id) {
          router.push(`/pitboss/cert/${data.certification_id}`)
          return
        }
        setError(data.error ?? 'Failed to start certification')
        return
      }

      sessionStorage.setItem(
        `cert:${data.certification_id}`,
        JSON.stringify(data)
      )
      router.push(`/pitboss/cert/${data.certification_id}`)
    } catch {
      setError('Network error — try again')
    } finally {
      setStarting(null)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button
        onClick={() => {
          if (selectedLeague) {
            setSelectedLeague(null)
            setRoles([])
            setError(null)
          } else {
            router.back()
          }
        }}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Certification</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {selectedLeague
            ? `${selectedLeague.name} — Select a role`
            : 'Select a league to begin'}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {/* Step 1 — League selection */}
      {!selectedLeague && (
        <div className="flex flex-col gap-3">
          {leagues.length === 0 && (
            <p className="text-white/30 text-sm text-center mt-12">
              No leagues available for certification.
            </p>
          )}
          {leagues.map((league) => (
            <button
              key={league.id}
              onClick={() => selectLeague(league)}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-left"
            >
              <p className="text-sm font-bold text-white">{league.name}</p>
              <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">
                {league.slug}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Step 2 — Role selection */}
      {selectedLeague && (
        <div className="flex flex-col gap-3">
          {loadingRoles && (
            <div className="flex justify-center mt-8">
              <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
            </div>
          )}

          {!loadingRoles && roles.length === 0 && (
            <p className="text-white/30 text-sm text-center mt-12">
              No exams available for this league.
            </p>
          )}

          {!loadingRoles &&
            roles.map((role) => {
              const isPassed     = role.status === 'passed'
              const isInProgress = role.status === 'in_progress'
              const isStarting   = starting === role.role_code
              const isLocked     =
                role.status === 'failed' &&
                role.locked_until &&
                new Date(role.locked_until) > new Date()

              return (
                <div
                  key={role.role_code}
                  className="rounded-xl border border-white/10 bg-white/5 p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 mr-3">
                      <p className="text-sm font-bold text-white">
                        {role.role_name}
                      </p>
                      {role.description && (
                        <p className="text-xs text-white/30 mt-0.5 line-clamp-2">
                          {role.description}
                        </p>
                      )}
                      <p className="text-[10px] text-white/20 mt-1">
                        {role.question_count} questions · {role.pass_mark}% to pass
                      </p>
                    </div>

                    {isPassed ? (
                      <span className="rounded-full bg-green-500/20 px-3 py-1 text-xs font-bold text-green-400 shrink-0">
                        Certified ✓
                      </span>
                    ) : isLocked ? (
                      <div className="text-right shrink-0">
                        <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-xs font-bold text-yellow-400">
                          Locked
                        </span>
                        <p className="text-[10px] text-white/30 mt-1">
                          Retry{' '}
                          {new Date(role.locked_until!).toLocaleDateString()}
                        </p>
                      </div>
                    ) : (
                      <button
                        onClick={() =>
                          isInProgress && role.certification_id
                            ? router.push(
                                `/pitboss/cert/${role.certification_id}`
                              )
                            : handleStart(selectedLeague.id, role.role_code)
                        }
                        disabled={isStarting}
                        className="rounded-xl bg-rise-red px-4 py-2 text-xs font-bold text-white disabled:opacity-50 shrink-0"
                      >
                        {isStarting ? '...' : isInProgress ? 'Resume' : 'Begin'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </main>
  )
}
