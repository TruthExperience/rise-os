import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const discordId = (session.user as any).discordId as string
  if (!discordId) {
    return NextResponse.json({ error: 'Discord ID missing from session' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: driver, error: driverError } = await supabase
    .schema('pitboss')
    .from('drivers')
    .select('id, discord_id, discord_username, discord_avatar, display_name, tier, pp_total, super_licence_status, created_at')
    .eq('discord_id', discordId)
    .maybeSingle()

  if (driverError) {
    console.error('[profile] driver lookup', driverError)
    return NextResponse.json({ error: driverError.message }, { status: 500 })
  }
  if (!driver) {
    return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 })
  }

  const { data: leagues } = await supabase
    .schema('pitboss')
    .from('driver_leagues')
    .select('id, role, certified, certified_at, joined_at, league_id')
    .eq('driver_id', driver.id)

  const leagueIds = (leagues ?? []).map((l) => l.league_id)

  let leagueNames: Record<string, { name: string; slug: string }> = {}
  if (leagueIds.length > 0) {
    const { data: leagueData } = await supabase
      .schema('rise_os')
      .from('leagues')
      .select('id, name, slug')
      .in('id', leagueIds)
    for (const l of leagueData ?? []) {
      leagueNames[l.id] = { name: l.name, slug: l.slug }
    }
  }

  const { data: licences } = await supabase
    .schema('pitboss')
    .from('licences')
    .select('id, licence_number, role_code, title, tier, status, issued_at, expires_at, league_id')
    .eq('driver_id', driver.id)
    .order('issued_at', { ascending: false })

  const { data: penalties } = await supabase
    .schema('pitboss')
    .from('penalty_ledger')
    .select('id, points, reason, issued_at, expires_at, league_id')
    .eq('driver_id', driver.id)
    .order('issued_at', { ascending: false })

  const { data: certifications } = await supabase
    .schema('pitboss')
    .from('certifications')
    .select('id, league_id, status, score, pass_mark, attempt_number, completed_at')
    .eq('driver_id', driver.id)
    .order('completed_at', { ascending: false })

  const enrichedLeagues = (leagues ?? []).map((l) => ({
    ...l,
    league: leagueNames[l.league_id] ?? null,
  }))

  return NextResponse.json({
    driver,
    leagues:       enrichedLeagues,
    licences:      licences ?? [],
    penalties:     penalties ?? [],
    certifications: certifications ?? [],
  })
}
