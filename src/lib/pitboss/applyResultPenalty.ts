// FILE: src/lib/pitboss/applyResultPenalty.ts   (replace the whole file)
//
// Moves a driver down the classification after a guilty steward ruling, and
// puts it back if an appeal overturns the ruling.
//
// Race results don't store race times, so a time penalty can't be turned into
// a new position automatically. The steward reads the new position off the
// timing screen and enters it as `position_drop` (positions lost). The seconds
// are kept on the incident and the penalty ledger for the record.
//
// For each result moved, points are re-based on league_points_table. Anything
// on top of the table value (fastest-lap bonus, a manual tweak) is kept:
//   new = old - table(oldPos) + table(newPos)
// Sprint results are not touched. Every change is logged in
// pitboss.result_adjustments so it can be reverted.
//
// Standings: recompute_driver_standings() rebuilds driver_standings from
// results.finish_position and results.points_earned for EVERY league, so it is
// called once per operation. Callers that run several operations in one
// request pass { recompute: false } and call it themselves once at the end.

import type { SupabaseClient } from '@supabase/supabase-js'
import { syncStandingsToDiscord, postRoundResultsToDiscord } from '@/lib/discord/standings-post'

interface IncidentLike {
  id: string
  league_id: string
  // pitboss.incidents.season and pitboss.results.season are both TEXT.
  season: string | number | null
  round: number | null
  accused_driver_id: string | null
}

export interface AdjustOutcome {
  applied: boolean
  note?: string
}

export interface AdjustOptions {
  // Default true. Pass false when the caller recomputes standings itself.
  recompute?: boolean
}

// result_adjustments.season is an integer column, results.season is text.
// Returns null for anything that isn't a whole number so the log insert
// can't fail on a value like "S1".
function toIntOrNull(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

async function pointsByPosition(
  supabase: SupabaseClient,
  leagueId: string
): Promise<Map<number, number>> {
  const { data } = await supabase
    .schema('pitboss')
    .from('league_points_table')
    .select('position, points')
    .eq('league_id', leagueId)
  return new Map((data ?? []).map((r: any) => [Number(r.position), Number(r.points ?? 0)]))
}

// Best-effort undo of rows already moved, used when a later step fails.
async function restoreRows(supabase: SupabaseClient, log: any[]): Promise<number> {
  let failed = 0
  for (const l of log) {
    const { error } = await supabase
      .schema('pitboss')
      .from('results')
      .update({ finish_position: l.finish_before, points_earned: l.points_before })
      .eq('id', l.result_id)
    if (error) failed++
  }
  return failed
}

export async function applyPositionDrop(
  supabase: SupabaseClient,
  incident: IncidentLike,
  drop: number,
  opts: AdjustOptions = {}
): Promise<AdjustOutcome> {
  const recompute = opts.recompute !== false

  if (!drop || drop <= 0) return { applied: false }
  if (!incident.accused_driver_id || incident.season == null || incident.round == null) {
    return { applied: false, note: 'Incident has no accused driver, season or round, so no result was changed.' }
  }

  // Never apply the same incident twice.
  const { data: active } = await supabase
    .schema('pitboss')
    .from('result_adjustments')
    .select('id')
    .eq('incident_id', incident.id)
    .is('reverted_at', null)
    .limit(1)
  if (active && active.length > 0) {
    return { applied: false, note: 'This incident has already moved results. Revert it before applying a new drop.' }
  }

  // dnf is nullable on older rows, so "not DNF" has to include NULL.
  const { data: rows, error } = await supabase
    .schema('pitboss')
    .from('results')
    .select('id, driver_id, finish_position, points_earned, dnf')
    .eq('league_id', incident.league_id)
    .eq('season', String(incident.season))
    .eq('round', incident.round)
    .not('finish_position', 'is', null)
    .or('dnf.is.null,dnf.eq.false')
    .order('finish_position', { ascending: true })
  if (error) return { applied: false, note: `Couldn't load results: ${error.message}` }

  const classified = rows ?? []
  const accused = classified.find((r: any) => r.driver_id === incident.accused_driver_id)
  if (!accused) {
    return { applied: false, note: 'No classified result found for the accused driver in that round.' }
  }

  const from = Number(accused.finish_position)
  const last = Math.max(...classified.map((r: any) => Number(r.finish_position)))
  const to = Math.min(from + drop, last)
  if (to <= from) return { applied: false, note: 'Driver already last, nothing to move.' }

  const table = await pointsByPosition(supabase, incident.league_id)
  const pts = (pos: number) => table.get(pos) ?? 0
  const rebase = (oldPts: number, oldPos: number, newPos: number) =>
    Math.max(0, Number(oldPts ?? 0) - pts(oldPos) + pts(newPos))

  const seasonInt = toIntOrNull(incident.season)

  // Everyone between the accused and their new slot moves up one place; the
  // accused goes to the new slot. (results has no unique index on
  // finish_position, only on league/driver/season/round, so no parking step.)
  const moves = [
    ...classified
      .filter((r: any) => Number(r.finish_position) > from && Number(r.finish_position) <= to)
      .map((r: any) => ({ row: r, before: Number(r.finish_position), after: Number(r.finish_position) - 1 })),
    { row: accused, before: from, after: to },
  ]

  const log: any[] = []
  for (const m of moves) {
    const newPts = rebase(m.row.points_earned, m.before, m.after)
    const { error: upErr } = await supabase
      .schema('pitboss')
      .from('results')
      .update({ finish_position: m.after, points_earned: newPts })
      .eq('id', m.row.id)
    if (upErr) {
      const failed = await restoreRows(supabase, log)
      return {
        applied: false,
        note: failed > 0
          ? `Couldn't update results: ${upErr.message}. Some rows could not be restored, so check this round's results by hand.`
          : `Couldn't update results: ${upErr.message}. Nothing was changed.`,
      }
    }
    log.push({
      incident_id: incident.id,
      result_id: m.row.id,
      league_id: incident.league_id,
      season: seasonInt,
      round: incident.round,
      finish_before: m.before,
      finish_after: m.after,
      points_before: Number(m.row.points_earned ?? 0),
      points_after: newPts,
    })
  }

  const { error: logErr } = await supabase
    .schema('pitboss')
    .from('result_adjustments')
    .insert(log)
  if (logErr) {
    // Without the log the change can't be reverted later, so put it back.
    const failed = await restoreRows(supabase, log)
    return {
      applied: false,
      note: failed > 0
        ? `Couldn't log the change (${logErr.message}) and some rows could not be restored. Check this round's results by hand.`
        : `Couldn't log the change (${logErr.message}), so results were left as they were.`,
    }
  }

  if (recompute) {
    const rc = await supabase.schema('pitboss').rpc('recompute_driver_standings')
    if (rc.error) {
      return { applied: true, note: `Results moved, but standings recompute failed: ${rc.error.message}` }
    }
    await postRoundResultsToDiscord(incident.league_id, incident.season as string, incident.round as number)
    await syncStandingsToDiscord(incident.league_id)
  }
  return { applied: true }
}

// Undo whatever this incident changed. A row is only restored if it still
// matches what the incident left it as, so a later manual edit isn't clobbered.
export async function revertIncidentAdjustments(
  supabase: SupabaseClient,
  incidentId: string,
  opts: AdjustOptions = {}
): Promise<AdjustOutcome> {
  const recompute = opts.recompute !== false

  const { data: adj } = await supabase
    .schema('pitboss')
    .from('result_adjustments')
    .select('*')
    .eq('incident_id', incidentId)
    .is('reverted_at', null)
  if (!adj || adj.length === 0) return { applied: false }

  const { data: current } = await supabase
    .schema('pitboss')
    .from('results')
    .select('id, finish_position, points_earned')
    .in('id', adj.map((a: any) => a.result_id))
  const byId = new Map((current ?? []).map((r: any) => [r.id, r]))

  const restorable = adj.filter((a: any) => {
    const r: any = byId.get(a.result_id)
    return r && Number(r.finish_position) === Number(a.finish_after)
  })

  const failedIds = new Set<string>()
  for (const a of restorable) {
    const { error } = await supabase
      .schema('pitboss')
      .from('results')
      .update({ finish_position: a.finish_before, points_earned: a.points_before })
      .eq('id', a.result_id)
    if (error) failedIds.add(a.id)
  }

  // Rows that failed to restore stay un-reverted so a retry can pick them up.
  // Rows that were skipped because someone edited them are closed out on
  // purpose: the incident no longer owns those rows.
  const toClose = adj.filter((a: any) => !failedIds.has(a.id)).map((a: any) => a.id)
  if (toClose.length > 0) {
    await supabase
      .schema('pitboss')
      .from('result_adjustments')
      .update({ reverted_at: new Date().toISOString() })
      .in('id', toClose)
  }

  const notes: string[] = []
  const skipped = adj.length - restorable.length
  if (skipped > 0) notes.push(`${skipped} result row(s) had been edited since, so they were left as they are.`)
  if (failedIds.size > 0) notes.push(`${failedIds.size} result row(s) could not be restored. Check this round's results by hand.`)

  if (recompute) {
    const rc = await supabase.schema('pitboss').rpc('recompute_driver_standings')
    if (rc.error) notes.push(`Standings recompute failed: ${rc.error.message}`)
  }
  return { applied: true, note: notes.length ? notes.join(' ') : undefined }
}
