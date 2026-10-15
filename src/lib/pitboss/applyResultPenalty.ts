// src/lib/pitboss/applyResultPenalty.ts
//
// Moves a driver down the classification after a guilty steward ruling, and
// puts it back if an appeal overturns the ruling.
//
// Race results don't store race times, so a time penalty can't be turned into
// a new position automatically. The steward reads the new position off the
// timing screen and enters it as `position_drop` (positions lost). The seconds
// are kept on the incident for the record.
//
// For each result moved, points are re-based on league_points_table. Anything
// on top of the table value (fastest-lap bonus, a manual tweak) is kept:
//   new = old - table(oldPos) + table(newPos)
// Sprint results are not touched. Every change is logged in
// pitboss.result_adjustments so it can be reverted.

import type { SupabaseClient } from '@supabase/supabase-js'

interface IncidentLike {
  id: string
  league_id: string
  season: number | null
  round: number | null
  accused_driver_id: string | null
}

export interface AdjustOutcome {
  applied: boolean
  note?: string
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

export async function applyPositionDrop(
  supabase: SupabaseClient,
  incident: IncidentLike,
  drop: number
): Promise<AdjustOutcome> {
  if (!drop || drop <= 0) return { applied: false }
  if (!incident.accused_driver_id || incident.season == null || incident.round == null) {
    return { applied: false, note: 'Incident has no accused driver, season or round, so no result was changed.' }
  }

  const { data: rows, error } = await supabase
    .schema('pitboss')
    .from('results')
    .select('id, driver_id, finish_position, points_earned, dnf')
    .eq('league_id', incident.league_id)
    .eq('season', incident.season)
    .eq('round', incident.round)
    .not('finish_position', 'is', null)
    .eq('dnf', false)
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

  // Park the accused first so a unique index on finish position can't trip.
  const park = await supabase.schema('pitboss').from('results')
    .update({ finish_position: null }).eq('id', accused.id)
  if (park.error) return { applied: false, note: `Couldn't update results: ${park.error.message}` }

  const log: any[] = []
  const shifted = classified.filter(
    (r: any) => Number(r.finish_position) > from && Number(r.finish_position) <= to
  )

  for (const r of shifted) {
    const before = Number(r.finish_position)
    const after = before - 1
    const newPts = rebase(r.points_earned, before, after)
    const up = await supabase.schema('pitboss').from('results')
      .update({ finish_position: after, points_earned: newPts }).eq('id', r.id)
    if (up.error) {
      await supabase.schema('pitboss').from('results')
        .update({ finish_position: from }).eq('id', accused.id)
      return { applied: false, note: `Couldn't update results: ${up.error.message}. Check this round's results by hand.` }
    }
    log.push({
      incident_id: incident.id, result_id: r.id, league_id: incident.league_id,
      season: incident.season, round: incident.round,
      finish_before: before, finish_after: after,
      points_before: Number(r.points_earned ?? 0), points_after: newPts,
    })
  }

  const accusedPts = rebase(accused.points_earned, from, to)
  const fin = await supabase.schema('pitboss').from('results')
    .update({ finish_position: to, points_earned: accusedPts }).eq('id', accused.id)
  if (fin.error) {
    return { applied: false, note: `Couldn't place the penalised driver: ${fin.error.message}. Check this round's results by hand.` }
  }
  log.push({
    incident_id: incident.id, result_id: accused.id, league_id: incident.league_id,
    season: incident.season, round: incident.round,
    finish_before: from, finish_after: to,
    points_before: Number(accused.points_earned ?? 0), points_after: accusedPts,
  })

  await supabase.schema('pitboss').from('result_adjustments').insert(log)

  const rc = await supabase.schema('pitboss').rpc('recompute_driver_standings')
  if (rc.error) {
    return { applied: true, note: `Results moved, but standings recompute failed: ${rc.error.message}` }
  }
  return { applied: true }
}

// Undo whatever this incident changed. A row is only restored if it still
// matches what the incident left it as, so a later manual edit isn't clobbered.
export async function revertIncidentAdjustments(
  supabase: SupabaseClient,
  incidentId: string
): Promise<AdjustOutcome> {
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

  // Park everything first so a unique index on finish position can't trip.
  const restorable = adj.filter((a: any) => {
    const r: any = byId.get(a.result_id)
    return r && Number(r.finish_position) === Number(a.finish_after)
  })
  for (const a of restorable) {
    await supabase.schema('pitboss').from('results')
      .update({ finish_position: null }).eq('id', a.result_id)
  }
  for (const a of restorable) {
    await supabase.schema('pitboss').from('results')
      .update({ finish_position: a.finish_before, points_earned: a.points_before })
      .eq('id', a.result_id)
  }
  const now = new Date().toISOString()
  await supabase.schema('pitboss').from('result_adjustments')
    .update({ reverted_at: now }).eq('incident_id', incidentId).is('reverted_at', null)

  const rc = await supabase.schema('pitboss').rpc('recompute_driver_standings')
  const skipped = adj.length - restorable.length
  const notes: string[] = []
  if (skipped > 0) notes.push(`${skipped} result row(s) had been edited since, so they were left as they are.`)
  if (rc.error) notes.push(`Standings recompute failed: ${rc.error.message}`)
  return { applied: true, note: notes.length ? notes.join(' ') : undefined }
}
