// Career mode race tracker: shared types, default points, and stat rollups.
// Pure functions only — safe to import from both API routes and client pages.

export type CareerSeries = 'f1' | 'f2'
export type RaceType = 'race' | 'sprint'
export type CareerPath = 'f2_f1' | 'f1_only'

export interface CareerRaceResult {
  id: string
  career_driver_id: string
  series: CareerSeries
  season: number
  round: number
  track_id: string | null
  track_name: string | null
  race_type: RaceType
  team_name: string | null
  quali_position: number | null
  grid_position: number | null
  finish_position: number | null
  dnf: boolean
  fastest_lap: boolean
  points: number
  recorded_by: string | null
  created_at: string
}

const FEATURE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
const F1_SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1]
const F2_SPRINT_POINTS = [10, 8, 6, 5, 4, 3, 2, 1]

// Suggested points under the standard scoring for each series. Career mode
// lets you change scoring, so the tracker always lets you override this.
//  - F1: 25-18-15-12-10-8-6-4-2-1, sprint 8-7-6-5-4-3-2-1, no fastest-lap point.
//  - F2: same feature table (+1 fastest lap if top 10, +2 for pole),
//        sprint 10-8-6-5-4-3-2-1.
export function defaultPoints(input: {
  series: CareerSeries
  raceType: RaceType
  finish: number | null
  dnf: boolean
  fastestLap: boolean
  quali: number | null
}): number {
  const { series, raceType, finish, dnf, fastestLap, quali } = input
  let pts = 0
  if (!dnf && finish != null && finish >= 1) {
    const table =
      raceType === 'sprint'
        ? series === 'f2'
          ? F2_SPRINT_POINTS
          : F1_SPRINT_POINTS
        : FEATURE_POINTS
    pts += table[finish - 1] ?? 0
    if (series === 'f2' && raceType === 'race' && fastestLap && finish <= 10) pts += 1
  }
  if (series === 'f2' && raceType === 'race' && quali === 1) pts += 2
  return pts
}

export interface CareerSummary {
  entries: number
  races: number // main/feature races
  sprints: number
  wins: number
  sprintWins: number
  podiums: number
  top5: number
  top10: number
  poles: number
  sprintPoles: number
  frontRows: number
  fastestLaps: number
  dnfs: number
  points: number
  bestFinish: number | null
  bestQuali: number | null
  avgFinish: number | null
  avgQuali: number | null
  avgPlacesGained: number | null // quali -> finish, main races with both
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}

export function summarize(results: CareerRaceResult[]): CareerSummary {
  const main = results.filter((r) => r.race_type === 'race')
  const sprint = results.filter((r) => r.race_type === 'sprint')
  const classifiedMain = main.filter((r) => !r.dnf && r.finish_position != null)
  const finishes = classifiedMain.map((r) => r.finish_position as number)
  const qualis = results.filter((r) => r.quali_position != null).map((r) => r.quali_position as number)
  const gained = classifiedMain
    .filter((r) => r.quali_position != null)
    .map((r) => (r.quali_position as number) - (r.finish_position as number))

  return {
    entries: results.length,
    races: main.length,
    sprints: sprint.length,
    wins: classifiedMain.filter((r) => r.finish_position === 1).length,
    sprintWins: sprint.filter((r) => !r.dnf && r.finish_position === 1).length,
    podiums: classifiedMain.filter((r) => (r.finish_position as number) <= 3).length,
    top5: classifiedMain.filter((r) => (r.finish_position as number) <= 5).length,
    top10: classifiedMain.filter((r) => (r.finish_position as number) <= 10).length,
    poles: main.filter((r) => r.quali_position === 1).length,
    sprintPoles: sprint.filter((r) => r.quali_position === 1).length,
    frontRows: main.filter((r) => r.quali_position != null && r.quali_position <= 2).length,
    fastestLaps: results.filter((r) => r.fastest_lap).length,
    dnfs: results.filter((r) => r.dnf).length,
    points: results.reduce((sum, r) => sum + (r.points ?? 0), 0),
    bestFinish: finishes.length ? Math.min(...finishes) : null,
    bestQuali: qualis.length ? Math.min(...qualis) : null,
    avgFinish: avg(finishes),
    avgQuali: avg(qualis),
    avgPlacesGained: avg(gained),
  }
}

export interface SeasonRow {
  key: string
  series: CareerSeries
  season: number
  team: string | null
  summary: CareerSummary
}

export function seasonBreakdown(results: CareerRaceResult[]): SeasonRow[] {
  const groups = new Map<string, CareerRaceResult[]>()
  for (const r of results) {
    const key = `${r.series}:${r.season}`
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const rows: SeasonRow[] = []
  groups.forEach((rs, key) => {
    const [series, season] = key.split(':')
    const team = rs.find((r) => r.team_name)?.team_name ?? null
    rows.push({ key, series: series as CareerSeries, season: Number(season), team, summary: summarize(rs) })
  })
  return rows.sort((a, b) => a.season - b.season || (a.series === 'f2' ? -1 : 1))
}

export function sortResults(results: CareerRaceResult[]): CareerRaceResult[] {
  return [...results].sort(
    (a, b) =>
      b.season - a.season ||
      b.round - a.round ||
      (a.race_type === b.race_type ? 0 : a.race_type === 'race' ? -1 : 1) ||
      b.created_at.localeCompare(a.created_at)
  )
}
