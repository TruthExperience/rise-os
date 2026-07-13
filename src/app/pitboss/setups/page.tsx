'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { SetupFeedbackPanel } from '@/components/setups/SetupFeedbackPanel'

interface CarClass {
  id: string
  code: string
  display_name: string
  category: string
  season: string
}

interface Track {
  id: string
  slug: string
  name: string
  country: string | null
  archetype: string | null
}

interface Rationale {
  value: number
  unit: string
  origin: string
  override_applied: boolean
  contributors: { submission_id: string; source_name: string | null; value: number; weight: number }[]
  adjustment?: { delta: number; reason: string; clamped: boolean }
}

interface Recommendation {
  id: string
  generated_setup: Record<string, number>
  rationale: Record<string, Rationale>
  confidence: number
  baseline_used: boolean
  model: string
  created_at: string
}

const CONDITIONS = ['dry', 'wet', 'mixed'] as const
const SESSION_TYPES = ['race', 'qualifying', 'sprint', 'time_trial', 'practice'] as const

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

export default function SetupsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [carClasses, setCarClasses] = useState<CarClass[]>([])
  const [tracks, setTracks]         = useState<Track[]>([])
  const [loadingOptions, setLoadingOptions] = useState(true)

  const [carClassId, setCarClassId]   = useState('')
  const [trackId, setTrackId]         = useState('')
  const [conditions, setConditions]   = useState<typeof CONDITIONS[number]>('dry')
  const [sessionType, setSessionType] = useState<typeof SESSION_TYPES[number]>('race')

  const [generating, setGenerating]   = useState(false)
  const [error, setError]             = useState('')
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    loadOptions()
  }, [])

  async function loadOptions() {
    setLoadingOptions(true)
    try {
      const res = await fetch('/api/pitboss/setups/options')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load options')
      setCarClasses(data.car_classes)
      setTracks(data.tracks)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoadingOptions(false)
    }
  }

  async function generateRecommendation() {
    if (!carClassId || !trackId) return
    setGenerating(true)
    setError('')
    setRecommendation(null)

    try {
      const res = await fetch('/api/setups/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          car_class_id: carClassId,
          track_id:     trackId,
          conditions,
          session_type: sessionType,
          // session.user.id is a Discord snowflake (next-auth jwt strategy,
          // token.sub seeded from the Discord profile id) — NOT a
          // pitboss.drivers.id. The API route resolves this server-side via
          // resolveDriverIdFromSession() against pitboss.drivers.discord_id.
          discord_id: session?.user?.discordId ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate recommendation')
      setRecommendation(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  function handleAdjusted(newRecommendationId: string, adjustedSetup: Record<string, number>) {
    if (!recommendation) return
    setRecommendation({
      ...recommendation,
      id: newRecommendationId,
      generated_setup: adjustedSetup,
    })
  }

  if (status === 'loading' || loadingOptions) {
    return (
      <div className="min-h-screen bg-[#1A1A1A] flex items-center justify-center">
        <p className="text-white animate-pulse">Loading…</p>
      </div>
    )
  }

  const selectedTrack = tracks.find((t) => t.id === trackId)

  return (
    <div className="min-h-screen bg-[#1A1A1A] pb-24">
      <div className="px-4 pt-8 pb-4">
        <button onClick={() => router.back()} className="text-white/40 text-sm mb-4">
          ← Back
        </button>
        <h1 className="text-white font-black text-2xl">Setup Generator</h1>
        <p className="text-gray-500 text-sm mt-1">Community-weighted baseline, tuned by your feedback.</p>
      </div>

      <div className="px-4 space-y-6">
        <div>
          <SectionHeader title="Car Class" />
          <div className="grid grid-cols-2 gap-2">
            {carClasses.map((cc) => (
              <button
                key={cc.id}
                onClick={() => setCarClassId(cc.id)}
                className={`rounded-xl px-4 py-3 text-left border transition-colors ${
                  carClassId === cc.id
                    ? 'border-[#E8284A] bg-[#E8284A]/10'
                    : 'border-gray-800 bg-gray-900'
                }`}
              >
                <p className="text-white text-sm font-semibold">{cc.display_name}</p>
                <p className="text-gray-500 text-xs">{cc.season}</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <SectionHeader title="Track" />
          <select
            value={trackId}
            onChange={(e) => setTrackId(e.target.value)}
            className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-white text-sm focus:outline-none focus:border-[#E8284A]"
          >
            <option value="">Select a track…</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.country ? ` — ${t.country}` : ''}
              </option>
            ))}
          </select>
          {selectedTrack?.archetype && (
            <p className="text-gray-500 text-xs mt-1.5 capitalize">{selectedTrack.archetype.replace(/_/g, ' ')}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <SectionHeader title="Conditions" />
            <div className="flex gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setConditions(c)}
                  className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold capitalize border transition-colors ${
                    conditions === c
                      ? 'border-[#E8284A] bg-[#E8284A]/10 text-white'
                      : 'border-gray-800 bg-gray-900 text-gray-500'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <SectionHeader title="Session" />
            <select
              value={sessionType}
              onChange={(e) => setSessionType(e.target.value as typeof SESSION_TYPES[number])}
              className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-white text-xs focus:outline-none focus:border-[#E8284A]"
            >
              {SESSION_TYPES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={generateRecommendation}
          disabled={!carClassId || !trackId || generating}
          className="w-full rounded-xl bg-[#E8284A] py-3 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {generating ? 'Generating…' : 'Generate Setup'}
        </button>

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {recommendation && (
          <>
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionHeader title="Generated Setup" />
                <div className="text-right">
                  <p className="text-xs text-gray-500">
                    {recommendation.baseline_used ? 'Class default' : `${Math.round(recommendation.confidence * 100)}% confidence`}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(recommendation.generated_setup).map(([key, value], i) => (
                      <tr key={key} className={i > 0 ? 'border-t border-gray-800' : ''}>
                        <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{key}</td>
                        <td className="px-4 py-2.5 text-right text-white font-mono text-xs">
                          {value}
                          {recommendation.rationale[key]?.unit && (
                            <span className="text-gray-600 ml-1">{recommendation.rationale[key].unit}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <SetupFeedbackPanel
              recommendationId={recommendation.id}
              currentSetup={recommendation.generated_setup}
              discordId={session?.user?.discordId}
              onAdjusted={handleAdjusted}
            />
          </>
        )}
      </div>
    </div>
  )
}
