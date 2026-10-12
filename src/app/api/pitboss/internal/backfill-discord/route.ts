import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import {
  openDiscordAppealTicket,
  openDiscordIncidentTicket,
} from '@/lib/discord/app-sync'

export const dynamic = 'force-dynamic'

// POST /api/pitboss/internal/backfill-discord?league_id=<uuid>
// Header: x-pitboss-key: <PITBOSS_INTERNAL_KEY>
// Opens Discord channels for open incidents and open appeals that were filed
// in the app and never got one. Scope it with league_id.
export async function POST(req: NextRequest) {
  const key = process.env.PITBOSS_INTERNAL_KEY
  if (!key || req.headers.get('x-pitboss-key') !== key) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const leagueId = req.nextUrl.searchParams.get('league_id')
  const supabase = createAdminClient()

  let incidentQuery = supabase
    .schema('pitboss')
    .from('incidents')
    .select('id')
    .is('ticket_channel_id', null)
    .in('status', ['open', 'under_review'])
    .order('created_at', { ascending: true })
    .limit(25)
  if (leagueId) incidentQuery = incidentQuery.eq('league_id', leagueId)

  let appealQuery = supabase
    .schema('pitboss')
    .from('incident_appeals')
    .select('id')
    .is('ticket_channel_id', null)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(25)
  if (leagueId) appealQuery = appealQuery.eq('league_id', leagueId)

  const [{ data: incidents }, { data: appeals }] = await Promise.all([incidentQuery, appealQuery])

  const results: { kind: string; id: string; result: unknown }[] = []

  for (const row of incidents ?? []) {
    results.push({ kind: 'incident', id: row.id, result: await openDiscordIncidentTicket(row.id) })
  }
  for (const row of appeals ?? []) {
    results.push({ kind: 'appeal', id: row.id, result: await openDiscordAppealTicket(row.id) })
  }

  return NextResponse.json({ processed: results.length, results })
}
