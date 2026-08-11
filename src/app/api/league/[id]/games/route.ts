import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Same admin-tier roles as the rulebook upload route (src/app/api/league/[id]/rules/route.ts),
// plus 'owner' — that route's list was missing it, which caused a real bug
// (league owner locked out of uploading their own rulebook). Included here
// from the start so games/results uploads don't repeat that.
const UPLOAD_ROLES = ['owner', 'commissioner', 'co_owner', 'admin', 'head_steward']

function noStoreFetch(url: RequestInfo | URL, options: RequestInit = {}) {
  return fetch(url, { ...options, cache: 'no-store' })
}

function getRiseOs() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'rise_os' },
      global: { fetch: noStoreFetch },
    }
  )
}

function getPitboss() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'pitboss' },
      global: { fetch: noStoreFetch },
    }
  )
}

async function requireUploadAccess(leagueId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthenticated' }, { status: 401 }) }
  }

  // pitboss.drivers is keyed by discord_id, not the Supabase auth user id —
  // resolve through public.users the same way getSupabaseUserId does.
  const { data: profile } = await supabase
    .from('users')
    .select('discord_id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (!profile?.discord_id) {
    return {
      error: NextResponse.json(
        { error: 'Account not linked to a driver profile' },
        { status: 403 }
      ),
    }
  }

  const pitboss = getPitboss()
  const { data: driver } = await pitboss
    .from('drivers')
    .select('id')
    .eq('discord_id', profile.discord_id)
    .single()

  if (!driver) {
    return { error: NextResponse.json({ error: 'Driver not found' }, { status: 403 }) }
  }

  const { data: membership } = await pitboss
    .from('driver_leagues')
    .select('role')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .single()

  if (!membership) {
    return { error: NextResponse.json({ error: 'Not a member of this league' }, { status: 403 }) }
  }

  const roles = membership.role.split(',').map((r: string) => r.trim().toLowerCase())
  const hasAccess = roles.some((r: string) => UPLOAD_ROLES.includes(r))
  if (!hasAccess) {
    return {
      error: NextResponse.json(
        { error: 'Insufficient permissions to upload results' },
        { status: 403 }
      ),
    }
  }

  return { discordUserId: profile.discord_id }
}

// GET — games for a league, filterable by season_id/week, plus computed
// standings (wins/losses straight off rise_os.franchises).
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const riseOs = getRiseOs()

  const seasonId = req.nextUrl.searchParams.get('season_id')
  const week = req.nextUrl.searchParams.get('week')

  let query = riseOs
    .from('games')
    .select(
      'id, season_id, week, home_franchise_id, away_franchise_id, home_score, away_score, played_at, created_at'
    )
    .eq('league_id', params.id)
    .order('week', { ascending: true })

  if (seasonId) query = query.eq('season_id', seasonId)
  if (week) query = query.eq('week', parseInt(week))

  const { data: games, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: franchises, error: franchiseError } = await riseOs
    .from('franchises')
    .select('id, name, abbreviation, logo_url, wins, losses')
    .eq('league_id', params.id)

  if (franchiseError) return NextResponse.json({ error: franchiseError.message }, { status: 500 })

  const franchiseMap = Object.fromEntries((franchises ?? []).map((f) => [f.id, f]))
  const enriched = (games ?? []).map((g) => ({
    ...g,
    home_franchise: franchiseMap[g.home_franchise_id] ?? null,
    away_franchise: franchiseMap[g.away_franchise_id] ?? null,
  }))

  const standings = (franchises ?? [])
    .map((f) => ({ id: f.id, name: f.name, abbreviation: f.abbreviation, logo_url: f.logo_url, wins: f.wins, losses: f.losses }))
    .sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0) || (a.losses ?? 0) - (b.losses ?? 0))

  return NextResponse.json(
    { games: enriched, standings },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' } }
  )
}

// POST — bulk insert games for a league (admin/commissioner/steward tier only)
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const access = await requireUploadAccess(params.id)
  if ('error' in access) return access.error

  const body = await req.json()
  const { rows } = body

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows[] required' }, { status: 400 })
  }

  const riseOs = getRiseOs()

  const inserts = rows.map((r: any) => ({
    league_id: params.id,
    season_id: r.season_id,
    week: r.week,
    home_franchise_id: r.home_franchise_id,
    away_franchise_id: r.away_franchise_id,
    home_score: r.home_score ?? null,
    away_score: r.away_score ?? null,
    played_at: r.played_at ?? null,
  }))

  const { data, error } = await riseOs.from('games').insert(inserts).select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { error: recomputeError } = await riseOs.rpc('recompute_franchise_records', {
    p_league_id: params.id,
  })

  if (recomputeError) {
    return NextResponse.json(
      { games: data, warning: `Games saved, but standings recompute failed: ${recomputeError.message}` },
      { status: 201 }
    )
  }

  return NextResponse.json({ games: data }, { status: 201 })
}

// PUT — edit a single game's score
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const access = await requireUploadAccess(params.id)
  if ('error' in access) return access.error

  const body = await req.json()
  const { game_id, ...updates } = body

  if (!game_id) {
    return NextResponse.json({ error: 'game_id required' }, { status: 400 })
  }

  const allowed = ['home_score', 'away_score', 'played_at', 'week']
  const patch = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  const riseOs = getRiseOs()
  const { data, error } = await riseOs
    .from('games')
    .update(patch)
    .eq('id', game_id)
    .eq('league_id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { error: recomputeError } = await riseOs.rpc('recompute_franchise_records', {
    p_league_id: params.id,
  })

  if (recomputeError) {
    return NextResponse.json({ game: data, warning: `Game updated, but standings recompute failed: ${recomputeError.message}` })
  }

  return NextResponse.json({ game: data })
}
