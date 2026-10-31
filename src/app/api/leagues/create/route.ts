// src/app/api/leagues/create/route.ts
//
// POST /api/leagues/create  { name, sport, currency_code?, discord_server_id? }
//
// Lets a signed-in Rise user create a new league and become its
// commissioner + owner. Creates:
//   1. rise_os.leagues          (private + 'trial' until setup is finished;
//                                the sync trigger mirrors it to pitboss.leagues)
//   2. rise_os.league_members   (role 'commissioner')
//   3. pitboss.drivers          (only if the user has no driver record yet)
//   4. pitboss.driver_leagues   (is_commissioner + is_owner)
// Everything is rolled back if a later step fails.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getSupabaseUserId } from '@/lib/supabase/server'
import { autoProvisionGuild } from '@/lib/pitboss/autoProvisionGuild'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SPORTS = ['sim_racing', 'cfb'] as const
const SNOWFLAKE_RE = /^\d{15,25}$/
const MAX_LEAGUES_PER_USER = 5

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function defaultCurrency(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '')
  return (letters.slice(0, 3) || 'LGE').padEnd(3, 'X')
}

export async function POST(req: NextRequest) {
  const userId = await getSupabaseUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 3 || name.length > 60) {
    return NextResponse.json({ error: 'League name must be 3–60 characters' }, { status: 400 })
  }

  const sport = body.sport
  if (!SPORTS.includes(sport)) {
    return NextResponse.json({ error: 'Pick a sport: sim_racing or cfb' }, { status: 400 })
  }

  let currency = defaultCurrency(name)
  if (typeof body.currency_code === 'string' && body.currency_code.trim() !== '') {
    if (!/^[A-Za-z]{3}$/.test(body.currency_code.trim())) {
      return NextResponse.json({ error: 'Currency code must be 3 letters' }, { status: 400 })
    }
    currency = body.currency_code.trim().toUpperCase()
  }

  let discordServerId: string | null = null
  if (typeof body.discord_server_id === 'string' && body.discord_server_id.trim() !== '') {
    discordServerId = body.discord_server_id.trim()
    if (!SNOWFLAKE_RE.test(discordServerId)) {
      return NextResponse.json({ error: 'Discord server ID must be digits only' }, { status: 400 })
    }
  }

  const db = createAdminClient()
  const rise = () => db.schema('rise_os')
  const pb = () => db.schema('pitboss')

  // Basic abuse guard
  const { count: owned } = await rise()
    .from('leagues')
    .select('id', { count: 'exact', head: true })
    .eq('commissioner_id', userId)
  if ((owned ?? 0) >= MAX_LEAGUES_PER_USER) {
    return NextResponse.json(
      { error: `You can create up to ${MAX_LEAGUES_PER_USER} leagues. Contact an admin for more.` },
      { status: 403 }
    )
  }

  // A Discord server can only back one league
  if (discordServerId) {
    const { data: clash } = await rise()
      .from('leagues')
      .select('id')
      .eq('discord_server_id', discordServerId)
      .maybeSingle()
    if (clash) {
      return NextResponse.json(
        { error: 'That Discord server is already linked to another league' },
        { status: 409 }
      )
    }
  }

  // Unique slug
  const baseSlug = slugify(name) || 'league'
  let slug = baseSlug
  for (let i = 2; i < 50; i++) {
    const { data: taken } = await rise().from('leagues').select('id').eq('slug', slug).maybeSingle()
    if (!taken) break
    slug = `${baseSlug}-${i}`
  }

  // 1. League
  const { data: league, error: leagueErr } = await rise()
    .from('leagues')
    .insert({
      name,
      slug,
      sport,
      commissioner_id: userId,
      currency_code: currency,
      discord_server_id: discordServerId,
      is_public: false,
      pitboss_status: 'trial',
    })
    .select('id, name, slug')
    .single()
  if (leagueErr || !league) {
    return NextResponse.json({ error: leagueErr?.message ?? 'Could not create league' }, { status: 500 })
  }

  const rollback = async () => {
    await pb().from('driver_leagues').delete().eq('league_id', league.id)
    await rise().from('league_members').delete().eq('league_id', league.id)
    await pb().from('leagues').delete().eq('id', league.id)
    await rise().from('leagues').delete().eq('id', league.id)
  }

  try {
    // Make sure the pitboss mirror exists (normally created by the sync trigger)
    const { data: mirror } = await pb().from('leagues').select('id').eq('id', league.id).maybeSingle()
    if (!mirror) {
      const { error } = await pb().from('leagues').insert({
        id: league.id,
        name,
        slug,
        sport,
        commissioner_id: userId,
        discord_server_id: discordServerId,
        is_public: false,
        pitboss_status: 'trial',
      })
      if (error) throw error
    }

    // 2. Rise membership
    const { error: memberErr } = await rise()
      .from('league_members')
      .upsert(
        { league_id: league.id, user_id: userId, role: 'commissioner', status: 'active' },
        { onConflict: 'league_id,user_id' }
      )
    if (memberErr) throw memberErr

    // 3. PitBoss driver record (find or create)
    const { data: userRow } = await db
      .from('users')
      .select('id, discord_id, username')
      .eq('id', userId)
      .maybeSingle()

    let driverId: string | null = null
    {
      const { data: byUser } = await pb().from('drivers').select('id').eq('user_id', userId).maybeSingle()
      driverId = byUser?.id ?? null
    }
    if (!driverId && userRow?.discord_id) {
      const { data: byDiscord } = await pb()
        .from('drivers')
        .select('id, user_id')
        .eq('discord_id', userRow.discord_id)
        .maybeSingle()
      if (byDiscord) {
        driverId = byDiscord.id
        if (!byDiscord.user_id) await pb().from('drivers').update({ user_id: userId }).eq('id', byDiscord.id)
      }
    }
    if (!driverId) {
      const { data: created, error } = await pb()
        .from('drivers')
        .insert({
          user_id: userId,
          discord_id: userRow?.discord_id ?? null,
          discord_username: userRow?.username ?? 'unknown',
        })
        .select('id')
        .single()
      if (error || !created) throw error ?? new Error('Could not create driver record')
      driverId = created.id
    }

    // 4. PitBoss leadership
    const { error: dlErr } = await pb()
      .from('driver_leagues')
      .upsert(
        {
          driver_id: driverId,
          league_id: league.id,
          role: 'commissioner',
          is_commissioner: true,
          is_owner: true,
          is_driver: false,
          league_name: name,
        },
        { onConflict: 'driver_id,league_id' }
      )
    if (dlErr) throw dlErr
  } catch (e: any) {
    await rollback()
    return NextResponse.json({ error: e?.message ?? 'Could not finish creating league' }, { status: 500 })
  }

  // Best-effort: if the bot is already in that server, set everything up now.
  let autoSetup: unknown = null
  if (discordServerId) {
    try {
      autoSetup = await autoProvisionGuild({ guildId: discordServerId, leagueId: league.id, force: true })
    } catch (e) {
      console.error('[leagues/create] auto setup failed:', e)
    }
  }

  return NextResponse.json({
    success: true,
    autoSetup,
    league: { id: league.id, name: league.name, slug: league.slug },
    next: `/pitboss/admin/setup?league_id=${league.id}`,
  })
}
