'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

interface Franchise {
  id: string
  name: string
  abbreviation: string | null
  wins: number | null
  losses: number | null
}

interface ParsedRow {
  raw: string
  week: number | null
  homeName: string
  awayName: string
  homeScore: number | null
  awayScore: number | null
  homeFranchise: Franchise | null
  awayFranchise: Franchise | null
  error: string | null
}

interface League {
  id: string
  name: string
  slug: string
}

// Matches a pasted team name against the league's franchise list by
// exact name, exact abbreviation, or case-insensitive substring — loose
// enough to handle "Alabama" matching "Alabama Crimson Tide" without
// requiring the paste source to use the franchise's full stored name.
function matchFranchise(name: string, franchises: Franchise[]): Franchise | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  return (
    franchises.find((f) => f.name.toLowerCase() === needle) ??
    franchises.find((f) => f.abbreviation?.toLowerCase() === needle) ??
    franchises.find((f) => f.name.toLowerCase().includes(needle) || needle.includes(f.name.toLowerCase())) ??
    null
  )
}

// Parses pasted rows. Accepts tab-separated (native paste from Excel/
// Google Sheets) or comma-separated text, one game per line, in the
// order: week, home team, home score, away team, away score.
// Score columns are optional (leave blank for an unplayed/scheduled game).
function parseRows(text: string, franchises: Franchise[]): ParsedRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim())
      const [weekRaw, homeName, homeScoreRaw, awayName, awayScoreRaw] = cells

      const week = weekRaw ? parseInt(weekRaw, 10) : null
      const homeScore = homeScoreRaw ? parseInt(homeScoreRaw, 10) : null
      const awayScore = awayScoreRaw ? parseInt(awayScoreRaw, 10) : null

      const homeFranchise = homeName ? matchFranchise(homeName, franchises) : null
      const awayFranchise = awayName ? matchFranchise(awayName, franchises) : null

      let error: string | null = null
      if (!homeName || !awayName) error = 'Missing a team name'
      else if (!homeFranchise) error = `No franchise match for "${homeName}"`
      else if (!awayFranchise) error = `No franchise match for "${awayName}"`
      else if (week === null || Number.isNaN(week)) error = 'Missing/invalid week'

      return {
        raw: line,
        week: Number.isNaN(week as number) ? null : week,
        homeName,
        awayName,
        homeScore: Number.isNaN(homeScore as number) ? null : homeScore,
        awayScore: Number.isNaN(awayScore as number) ? null : awayScore,
        homeFranchise,
        awayFranchise,
        error,
      }
    })
}

export function GamesResultsInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { status } = useSession()

  const [leagues, setLeagues] = useState<League[]>([])
  const [league, setLeague] = useState<League | null>(null)
  const [franchises, setFranchises] = useState<Franchise[]>([])
  const [seasonId, setSeasonId] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingFranchises, setLoadingFranchises] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/leagues')
      .then((r) => r.json())
      .then((d) => setLeagues(d.leagues ?? []))
      .finally(() => setLoading(false))
  }, [status])

  useEffect(() => {
    const leagueId = searchParams.get('league')
    if (leagueId && leagues.length > 0) {
      const found = leagues.find((l) => l.id === leagueId)
      if (found) setLeague(found)
    }
  }, [leagues, searchParams])

  useEffect(() => {
    if (!league) return
    setLoadingFranchises(true)
    fetch(`/api/franchises/${league.id}`)
      .then((r) => r.json())
      .then((d) => setFranchises(Array.isArray(d) ? d : d.franchises ?? []))
      .finally(() => setLoadingFranchises(false))
  }, [league])

  function handlePasteChange(text: string) {
    setPasteText(text)
    setParsedRows(parseRows(text, franchises))
    setSaved(false)
  }

  async function handleSubmit() {
    if (!league) return
    const validRows = parsedRows.filter((r) => !r.error)
    if (validRows.length === 0) return

    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/league/${league.id}/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: validRows.map((r) => ({
            season_id: seasonId || null,
            week: r.week,
            home_franchise_id: r.homeFranchise!.id,
            away_franchise_id: r.awayFranchise!.id,
            home_score: r.homeScore,
            away_score: r.awayScore,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save games')
      setSaved(true)
      setPasteText('')
      setParsedRows([])
      // Refresh franchise records so the standings preview reflects the new games.
      const refreshed = await fetch(`/api/franchises/${league.id}`).then((r) => r.json())
      setFranchises(Array.isArray(refreshed) ? refreshed : refreshed.franchises ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (status === 'loading' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    )
  }

  const validCount = parsedRows.filter((r) => !r.error).length
  const errorCount = parsedRows.length - validCount

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button
        onClick={() => {
          if (league) setLeague(null)
          else router.back()
        }}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">Game Results</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          {league ? league.name : 'Select a league'}
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-sm text-rise-red">{error}</p>
        </div>
      )}

      {!league && (
        <div className="space-y-2">
          {leagues.map((l) => (
            <button
              key={l.id}
              onClick={() => setLeague(l)}
              className="w-full text-left rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white hover:border-rise-red/50"
            >
              {l.name}
            </button>
          ))}
        </div>
      )}

      {league && (
        <div className="space-y-6">
          <div>
            <label className="text-xs text-white/30 uppercase tracking-widest">Season ID (optional)</label>
            <input
              value={seasonId}
              onChange={(e) => setSeasonId(e.target.value)}
              placeholder="Leave blank if not tracking by season_id"
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-white/30 uppercase tracking-widest">
              Paste results
            </label>
            <p className="text-xs text-white/40 mt-1 mb-2">
              One game per line — paste straight from a spreadsheet (tab-separated) or type
              comma-separated: <code className="text-white/60">week, home team, home score, away team, away score</code>.
              Leave scores blank for a scheduled/unplayed game.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => handlePasteChange(e.target.value)}
              rows={10}
              placeholder={'1, Alabama, 34, Georgia, 27\n1, Ohio State, , Michigan, '}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white text-sm font-mono"
            />
          </div>

          {loadingFranchises && <p className="text-xs text-white/30">Loading franchises…</p>}

          {parsedRows.length > 0 && (
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-white/40 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2">Wk</th>
                    <th className="text-left px-3 py-2">Home</th>
                    <th className="text-left px-3 py-2">Score</th>
                    <th className="text-left px-3 py-2">Away</th>
                    <th className="text-left px-3 py-2">Score</th>
                    <th className="text-left px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r, i) => (
                    <tr key={i} className={`border-t border-white/5 ${r.error ? 'bg-rise-red/5' : ''}`}>
                      <td className="px-3 py-2 text-white/70">{r.week ?? '—'}</td>
                      <td className="px-3 py-2 text-white/70">
                        {r.homeFranchise?.name ?? <span className="text-rise-red">{r.homeName || '—'}</span>}
                      </td>
                      <td className="px-3 py-2 text-white/70">{r.homeScore ?? '—'}</td>
                      <td className="px-3 py-2 text-white/70">
                        {r.awayFranchise?.name ?? <span className="text-rise-red">{r.awayName || '—'}</span>}
                      </td>
                      <td className="px-3 py-2 text-white/70">{r.awayScore ?? '—'}</td>
                      <td className="px-3 py-2">
                        {r.error ? (
                          <span className="text-rise-red text-xs">{r.error}</span>
                        ) : (
                          <span className="text-green-400 text-xs">Ready</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {parsedRows.length > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/40">
                {validCount} ready{errorCount > 0 ? `, ${errorCount} with errors (won't be submitted)` : ''}
              </p>
              <button
                onClick={handleSubmit}
                disabled={submitting || validCount === 0}
                className="rounded-lg bg-rise-red px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
              >
                {submitting ? 'Saving…' : `Save ${validCount} game${validCount === 1 ? '' : 's'}`}
              </button>
            </div>
          )}

          {saved && (
            <div className="rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
              <p className="text-sm text-green-400">Games saved and standings recomputed.</p>
            </div>
          )}

          {franchises.length > 0 && (
            <div>
              <h2 className="text-xs text-white/30 uppercase tracking-widest mb-2">Current Standings</h2>
              <div className="rounded-xl border border-white/10 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-white/5 text-white/40 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-3 py-2">Team</th>
                      <th className="text-left px-3 py-2">W</th>
                      <th className="text-left px-3 py-2">L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...franchises]
                      .sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0) || (a.losses ?? 0) - (b.losses ?? 0))
                      .map((f) => (
                        <tr key={f.id} className="border-t border-white/5">
                          <td className="px-3 py-2 text-white/70">{f.name}</td>
                          <td className="px-3 py-2 text-white/70">{f.wins ?? 0}</td>
                          <td className="px-3 py-2 text-white/70">{f.losses ?? 0}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
