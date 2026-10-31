// src/app/api/pitboss/admin/setup/auto/route.ts
//
// POST /api/pitboss/admin/setup/auto  { league_id }
// "Auto-detect from Discord" button on the setup dashboard: reads the linked
// server's roles and channels, fills what's empty, and syncs members.
// Gated on commissioner / owner / co-owner.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver, createAdminClient } from '@/lib/supabase/server'
import { isPitbossLeagueAdmin } from '@/lib/pitboss/leagueAdminAccess'
import { autoProvisionGuild } from '@/lib/pitboss/autoProvisionGuild'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const driver = await getAuthedDriver()
  if (!driver) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { league_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const leagueId = body.league_id
  if (!leagueId || !UUID_RE.test(leagueId)) {
    return NextResponse.json({ error: 'A valid league_id is required' }, { status: 400 })
  }
  if (!(await isPitbossLeagueAdmin(driver.id, leagueId))) {
    return NextResponse.json({ error: 'Only league owners, co-owners and commissioners can do this' }, { status: 403 })
  }

  const { data: league } = await (createAdminClient() as any)
    .schema('rise_os')
    .from('leagues')
    .select('discord_server_id')
    .eq('id', leagueId)
    .maybeSingle()
  if (!league?.discord_server_id) {
    return NextResponse.json({ error: 'Link the Discord server first' }, { status: 400 })
  }

  const result = await autoProvisionGuild({
    guildId: league.discord_server_id,
    leagueId,
    force: true,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
