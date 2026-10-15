// FILE: src/lib/pitboss/incidentPenaltyRows.ts
//
// Builds the penalty_ledger rows for an incident ruling: one pp row, one time
// row and one grid row, as needed. Same row shape the web resolve and appeal
// routes write, so Discord rulings and web rulings look identical in the
// ledger. Time and grid rows carry points = 0, so the pp_total trigger (which
// sums `points` only) is not affected by them.

export interface IncidentPenaltyInput {
  driverId: string
  leagueId: string
  incidentId: string
  issuedBy: string | null
  issuedAt: string
  reason: string
  // pitboss.incidents.season is TEXT; the ledger column is an integer.
  season: string | number | null
  round: number | null
  points: number
  timeSeconds: number
  gridPlaces: number
  gridBack: boolean
}

function toIntOrNull(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

export function buildIncidentLedgerRows(p: IncidentPenaltyInput): Record<string, unknown>[] {
  const base = {
    driver_id:   p.driverId,
    league_id:   p.leagueId,
    incident_id: p.incidentId,
    issued_at:   p.issuedAt,
    issued_by:   p.issuedBy,
    source:      'incident',
    reason:      p.reason,
  }
  const appliesSeason = toIntOrNull(p.season)
  const rows: Record<string, unknown>[] = []

  if (p.points > 0) {
    rows.push({ ...base, penalty_type: 'pp', points: p.points })
  }
  if (p.timeSeconds > 0) {
    rows.push({
      ...base,
      penalty_type:         'time',
      points:               0,
      time_penalty_seconds: p.timeSeconds,
      time_label:           `+${p.timeSeconds}s`,
      applies_season:       appliesSeason,
      applies_round:        p.round ?? null,
    })
  }
  if (p.gridPlaces > 0 || p.gridBack) {
    rows.push({
      ...base,
      penalty_type:   'grid',
      points:         0,
      grid_places:    p.gridPlaces > 0 ? p.gridPlaces : null,
      grid_back:      p.gridBack,
      applies_season: appliesSeason,
      applies_round:  p.round ?? null,
    })
  }
  return rows
}
