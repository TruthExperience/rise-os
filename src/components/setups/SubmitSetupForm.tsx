'use client'

import { useEffect, useMemo, useState } from 'react'

interface ParamRange {
  param_key: string
  param_group: string
  min_value: number
  max_value: number
  default_value: number
  step: number
  unit: string
}

interface SubmitSetupFormProps {
  carClassId: string
  trackId: string
  conditions: 'dry' | 'wet' | 'mixed'
  sessionType: 'race' | 'qualifying' | 'sprint' | 'time_trial' | 'practice'
  leagueId?: string | null
  discordId?: string | null
}

const GROUP_LABELS: Record<string, string> = {
  aerodynamics: 'Aerodynamics',
  brakes: 'Brakes',
  fuel: 'Fuel',
  suspension: 'Suspension',
  suspension_geometry: 'Suspension Geometry',
  transmission: 'Transmission',
  tyres: 'Tyres',
}

export function SubmitSetupForm({ carClassId, trackId, conditions, sessionType, leagueId = null, discordId }: SubmitSetupFormProps) {
  const [expanded, setExpanded] = useState(false)
  const [params, setParams] = useState<ParamRange[]>([])
  const [loadingParams, setLoadingParams] = useState(false)
  const [values, setValues] = useState<Record<string, number>>({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // Hidden debug toggle — tap the header title 5x to reveal raw param
  // payload as received by the client. Not gated behind an env flag on
  // purpose: this needs to work against production without a redeploy,
  // since the bug we're chasing may only reproduce on live data.
  const [titleTapCount, setTitleTapCount] = useState(0)
  const [debugVisible, setDebugVisible] = useState(false)

  function handleTitleTap() {
    const next = titleTapCount + 1
    setTitleTapCount(next)
    if (next >= 5) {
      setDebugVisible((prev) => !prev)
      setTitleTapCount(0)
    }
  }

  useEffect(() => {
    if (!expanded || !carClassId || !sessionType) return
    setLoadingParams(true)
    setError('')
    fetch(`/api/pitboss/setups/params?car_class_id=${carClassId}&session_type=${sessionType}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        const ranges: ParamRange[] = data.params ?? []
        if (debugVisible) {
          console.log('RAW PARAMS RESPONSE:', JSON.stringify(ranges, null, 2))
        }
        setParams(ranges)
        setValues(
          Object.fromEntries(ranges.map((r) => [r.param_key, r.default_value ?? r.min_value]))
        )
      })
      .catch((err) => setError(err.message ?? 'Failed to load setup parameters'))
      .finally(() => setLoadingParams(false))
  }, [expanded, carClassId, sessionType, debugVisible])

  const grouped = useMemo(() => {
    const groups: Record<string, ParamRange[]> = {}
    for (const p of params) {
      groups[p.param_group] = groups[p.param_group] ?? []
      groups[p.param_group].push(p)
    }
    return groups
  }, [params])

  function updateValue(key: string, v: number) {
    setValues((prev) => ({ ...prev, [key]: v }))
    setSuccess(false)
  }

  async function handleSubmit() {
    if (!discordId) {
      setError('You need to be signed in to submit a setup.')
      return
    }
    setSubmitting(true)
    setError('')
    setSuccess(false)
    try {
      const res = await fetch('/api/pitboss/setups/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_id: leagueId,
          car_class_id: carClassId,
          track_id: trackId,
          conditions,
          session_type: sessionType,
          setup_values: values,
          notes: notes.trim() || null,
          discord_id: discordId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to submit setup')
      setSuccess(true)
      setNotes('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p
            className="text-white text-sm font-semibold"
            onClick={(e) => {
              e.stopPropagation()
              handleTitleTap()
            }}
          >
            Submit Your Own Setup
          </p>
          <p className="text-gray-500 text-xs mt-0.5">
            Ran a setup that worked? Contribute it — future recommendations here will factor it in.
          </p>
        </div>
        <span className="text-[#E8284A] text-lg">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800 pt-4">
          {debugVisible && (
            <div className="rounded-lg border border-green-700 bg-black p-2">
              <p className="text-green-400 text-[9px] uppercase tracking-wide mb-1">
                Debug — raw params from API ({params.length} total, {params.filter((p) => p.param_group === 'tyres').length} tyres)
              </p>
              <pre className="text-[8px] text-green-400 overflow-auto max-h-64 whitespace-pre-wrap break-all">
                {JSON.stringify(params.filter((p) => p.param_group === 'tyres'), null, 2)}
              </pre>
            </div>
          )}

          {loadingParams ? (
            <p className="text-gray-500 text-xs">Loading setup parameters…</p>
          ) : params.length === 0 ? (
            <p className="text-gray-500 text-xs">No setup parameters configured for this car class / session type.</p>
          ) : (
            <>
              {Object.entries(grouped).map(([group, groupParams]) => (
                <div key={group}>
                  <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide mb-2">
                    {GROUP_LABELS[group] ?? group}
                    {debugVisible && (
                      <span className="text-green-400 ml-2 normal-case">({groupParams.length})</span>
                    )}
                  </p>
                  <div className="space-y-3">
                    {groupParams.map((p) => (
                      <div key={p.param_key}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-gray-400 text-xs">{p.param_key.replace(/_/g, ' ')}</span>
                          <span className="text-white text-xs font-mono">
                            {values[p.param_key]}
                            <span className="text-gray-600 ml-1">{p.unit}</span>
                          </span>
                        </div>
                        <input
                          type="range"
                          min={p.min_value}
                          max={p.max_value}
                          step={p.step}
                          value={values[p.param_key] ?? p.default_value}
                          onChange={(e) => updateValue(p.param_key, Number(e.target.value))}
                          className="w-full accent-[#E8284A]"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div>
                <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide mb-2">Notes</p>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional — what made this setup work for you?"
                  rows={2}
                  className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-white text-sm placeholder-white/20 focus:outline-none focus:border-[#E8284A] resize-none"
                />
              </div>

              {error && <p className="text-red-400 text-xs">{error}</p>}
              {success && <p className="text-green-400 text-xs">Setup submitted — thanks for contributing.</p>}

              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="w-full rounded-lg bg-[#E8284A] py-2.5 text-sm font-bold text-white disabled:opacity-40"
              >
                {submitting ? 'Submitting…' : 'Submit Setup'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
