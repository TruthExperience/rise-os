// File: app/api/pitboss/drivers/[id]/career-stats/route.ts
//
// Public read-only aggregate for the driver profile page's "Career" tab.
// No ownership/session check — this is public career history, same as the
// rest of the profile route this page already calls.
//
// Source of truth: pitboss.results, grouped by driver_id. Currently empty
// league-wide (race-result entry isn't built yet), so this route also
// returns team history from driver_contracts as a fallback so the "Teams
// Driven For" section isn't blank just because results are.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

interface TeamDrivenFor {
  franchise_id: string
  name: string
  abbreviation: string | null
  logo_url: string | null
  primary_color: string | null
  source: 'results' | 'contract'
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createAdminClient()

  const { data: results, error: resultsError } = await supabase
    .schema('pitboss')
    .from('results')
    .select('finish_position, dnf, fastest_lap, franchise_id, season, round')
    .eq('driver_id', id)

  if (resultsError) {
    return NextResponse.json({ error: resultsError.message }, { status: 500 })
  }

  const rows = results ?? []

  const stats = {
    starts: rows.length,
    wins: rows.filter((r) => r.finish_position === 1).length,
    top3: rows.filter((r) => r.finish_position !== null && r.finish_position <= 3).length,
    top5: rows.filter((r) => r.finish_position !== null && r.finish_position <= 5).length,
    top10: rows.filter((r) => r.finish_position !== null && r.finish_position <= 10).length,
    dnfs: rows.filter((r) => r.dnf).length,
    fastest_laps: rows.filter((r) => r.fastest_lap).length,
  }

  const franchiseIdsFromResults = Array.from(
    new Set(rows.map((r) => r.franchise_id).filter((f): f is string => !!f))
  )

  let teams: TeamDrivenFor[] = []
  let teamsSource: 'results' | 'contract' | 'none' = 'none'

  if (franchiseIdsFromResults.length > 0) {
    const { data: franchises } = await supabase
      .schema('rise_os')
      .from('franchises')
      .select('id, name, abbreviation, logo_url, primary_color')
      .in('id', franchiseIdsFromResults)

    teams = (franchises ?? []).map((f) => ({
      franchise_id: f.id,
      name: f.name,
      abbreviation: f.abbreviation,
      logo_url: f.logo_url,
      primary_color: f.primary_color,
      source: 'results' as const,
    }))
    teamsSource = 'results'
  } else {
    // Fallback: results table is empty league-wide right now, so derive
    // team history from contracts instead of showing nothing. Two-step
    // lookup (not an embedded join) since driver_contracts is in pitboss
    // and franchises is in rise_os — cross-schema embeds via .schema()
    // aren't reliable, so resolve franchise_ids first like the results path.
    const { data: contracts } = await supabase
      .schema('pitboss')
      .from('driver_contracts')
      .select('franchise_id')
      .eq('driver_id', id)

    const franchiseIdsFromContracts = Array.from(
      new Set((contracts ?? []).map((c) => c.franchise_id).filter((f): f is string => !!f))
    )

    if (franchiseIdsFromContracts.length > 0) {
      const { data: franchises } = await supabase
        .schema('rise_os')
        .from('franchises')
        .select('id, name, abbreviation, logo_url, primary_color')
        .in('id', franchiseIdsFromContracts)

      teams = (franchises ?? []).map((f) => ({
        franchise_id: f.id,
        name: f.name,
        abbreviation: f.abbreviation,
        logo_url: f.logo_url,
        primary_color: f.primary_color,
        source: 'contract' as const,
      }))
      teamsSource = 'contract'
    }
  }

  return NextResponse.json({
    stats,
    teams,
    teams_source: teamsSource,
    has_results: rows.length > 0,
  })
}
