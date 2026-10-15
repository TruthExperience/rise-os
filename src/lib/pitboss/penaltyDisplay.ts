// FILE: src/lib/pitboss/penaltyDisplay.ts
//
// What to show in the points slot of a penalty_ledger row on the Penalties
// pages. pp rows show "+N PP". Time and grid rows carry points = 0, so they
// show the sporting penalty itself ("+5s", "3 places") instead of "+0 PP".

export interface PenaltyDisplayFields {
  penalty_type?: string | null
  points: number
  time_penalty_seconds?: number | null
  time_label?: string | null
  grid_places?: number | null
  grid_back?: boolean | null
  applies_round?: number | null
}

export function penaltyDisplay(p: PenaltyDisplayFields): { value: string; unit: string; detail: string | null } {
  const round = p.applies_round != null ? `Round ${p.applies_round}` : null

  if (p.penalty_type === 'time') {
    const secs = p.time_penalty_seconds ?? 0
    return { value: p.time_label || `+${secs}s`, unit: 'TIME', detail: round }
  }

  if (p.penalty_type === 'grid') {
    const places = p.grid_places ?? 0
    if (p.grid_back) {
      return {
        value: places > 0 ? `${places} places + back` : 'Back of grid',
        unit: 'GRID',
        detail: round,
      }
    }
    return { value: `${places} place${places === 1 ? '' : 's'}`, unit: 'GRID', detail: round }
  }

  return { value: `+${p.points}`, unit: 'PP', detail: null }
}
