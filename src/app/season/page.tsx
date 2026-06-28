'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface CalendarRound {
  id: string
  league_id: string
  season_number: number
  round_number: number | null
  type: 'race' | 'break' | 'testing'
  name: string
  circuit: string | null
  country: string | null
  flag_emoji: string | null
  race_date: string | null
  break_start: string | null
  break_end: string | null
  break_label: string | null
}

interface League {
  id: string
  name: string
  slug: string
}

const LEAGUE_SLUGS = ['trl', 'wsc']

export default function SeasonPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { status } = useSession()
  const [leagues, setLeagues]             = useState<League[]>([])
  const [selectedLeague, setSelected]     = useState<League | null>(null)
  const [rounds, setRounds]               = useState<CalendarRound[]>([])
  const [loading, setLoading]             = useState(true)
  const [loadingRounds, setLoadingRounds] = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((data) => {
        const all = (data.leagues ?? data) as League[]
        const filtered = all.filter((l) => LEAGUE_SLUGS.includes(l.slug))
        setLeagues(filtered)

        // Auto-select if league_id param present
        const paramId = searchParams.get('league_id')
        if (paramId) {
          const match = filtered.find((l) => l.id === paramId)
          if (match) selectLeague(match)
        }
      })
      .catch(() => setError('Failed to load leagues'))
      .finally(() => setLoading(false))
  }, [status])

  async function selectLeague(league: League) {
    setSelected(league)
    setRounds([])
    setError(null)
    setLoadingRounds(true)
    try {
      const res = await fetch(`/api/season/calendar?league_id=${league.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load calendar')
      setRounds(data.rounds ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingRounds(false)
    }
  }

  const today = new Date()

  function getRoundStatus(round: CalendarRound) {
    if (round.type !== 'race' || !round.race_date) return null
    const d = new Date(round.race_date)
    if (d < today) return 'past'
    const diff = d.getTime() - today.getTime()
    if (diff < 7 * 24 * 60 * 60 * 1000) return 'next'
    return 'upcoming'
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
            setSelected(null)
            setRounds([])
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
        <h1 className="text-2xl font-black text-white">Season Calendar</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {selectedLeague ? selectedLeague.name : 'Select a league'}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {/* League selector */}
      {!selectedLeague && (
        <div className="flex flex-col gap-3">
          {leagues.map((league) => (
            <button
              key={league.id}
              onClick={() => selectLeague(league)}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-left active:scale-[0.98] transition-transform"
            >
              <p className="text-sm font-bold text-white">{league.name}</p>
              <p className="text-xs text-white/30 uppercase tracking-widest mt-0.5">{league.slug}</p>
            </button>
          ))}
        </div>
      )}

      {/* Calendar */}
      {selectedLeague && (
        <div className="flex flex-col gap-2">
          {loadingRounds && (
            <div className="flex justify-center mt-8">
              <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
            </div>
          )}

          {!loadingRounds && rounds.length === 0 && (
            <p className="text-white/30 text-sm text-center mt-12">No calendar data available.</p>
          )}

          {!loadingRounds && rounds.map((round) => {
            if (round.type === 'testing') {
              return (
                <div key={round.id} className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
                  <span className="text-blue-400 text-lg">🔬</span>
                  <div>
                    <p className="text-blue-300 text-xs font-bold uppercase tracking-wide">{round.break_label}</p>
                    <p className="text-white/30 text-[10px] mt-0.5">
                      {round.break_start && new Date(round.break_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {round.break_end && round.break_end !== round.break_start &&
                        ` – ${new Date(round.break_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                    </p>
                  </div>
                </div>
              )
            }

            if (round.type === 'break') {
              const isHalf = round.break_label?.toLowerCase().includes('half')
              return (
                <div key={round.id} className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${isHalf ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-white/10 bg-white/5'}`}>
                  <span className="text-lg">{isHalf ? '🟡' : '🛑'}</span>
                  <div>
                    <p className={`text-xs font-bold uppercase tracking-wide ${isHalf ? 'text-yellow-400' : 'text-white/50'}`}>
                      {round.break_label}
                    </p>
                    <p className="text-white/30 text-[10px] mt-0.5">
                      {round.break_start && new Date(round.break_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {round.break_end && round.break_end !== round.break_start &&
                        ` – ${new Date(round.break_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                    </p>
                  </div>
                </div>
              )
            }

            const rStatus = getRoundStatus(round)
            const isNext = rStatus === 'next'
            const isPast = rStatus === 'past'

            return (
              <div
                key={round.id}
                className={`rounded-xl border p-4 flex items-center gap-4 transition-all ${
                  isNext
                    ? 'border-rise-red/60 bg-rise-red/10'
                    : isPast
                    ? 'border-white/5 bg-white/[0.02] opacity-50'
                    : 'border-white/10 bg-white/5'
                }`}
              >
                <div className={`shrink-0 w-10 h-10 rounded-lg flex flex-col items-center justify-center ${isNext ? 'bg-rise-red' : 'bg-white/10'}`}>
                  <span className="text-[8px] font-bold uppercase text-white/60 leading-none">RND</span>
                  <span className="text-sm font-black text-white leading-tight">
                    {String(round.round_number ?? '').padStart(2, '0')}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{round.flag_emoji}</span>
                    <p className="text-white font-bold text-sm truncate">{round.name}</p>
                  </div>
                  {round.circuit && (
                    <p className="text-white/30 text-[10px] mt-0.5 truncate">{round.circuit}</p>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  {round.race_date && (
                    <p className="text-white/60 text-xs">
                      {new Date(round.race_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </p>
                  )}
                  {isNext && (
                    <span className="text-[10px] font-bold text-rise-red uppercase tracking-wide">Next</span>
                  )}
                  {isPast && (
                    <span className="text-[10px] text-white/20 uppercase">Done</span>
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
