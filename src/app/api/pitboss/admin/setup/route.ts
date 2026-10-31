// src/app/api/pitboss/admin/setup/route.ts
//
// GET   /api/pitboss/admin/setup?league_id=<uuid>
//   Returns a setup-readiness checklist for the league: what is configured,
//   what is missing, and where to fix it.
//
// PATCH /api/pitboss/admin/setup   { league_id, ...fields }
//   Updates the league-level settings the checklist depends on (Discord IDs,
//   status, visibility, currency).
//
// Gated on commissioner / owner / co-owner of the league.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthedDriver, createAdminClient } from '@/lib/supabase/server'
import { isPitbossLeagueAdmin } from '@/lib/pitboss/leagueAdminAccess'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNOWFLAKE_RE = /^\d{15,25}$/

type Status = 'done' | 'partial' | 'todo'

interface Check {
  id: string
  group: 'Basics' | 'Discord' | 'People' | 'Rules & Certification' | 'Competition' | 'Go live'
  label: string
  description: string
  status: Status
  detail: string
  required: boolean
  /** In-app page that fixes this, if any. {leagueId} / {slug} are substituted client-side. */
  href?: string
  /** Settings fields editable inline on the dashboard for this check. */
  fields?: string[]
}

const DISCORD_FIELDS = [
  'discord_server_id',
  'discord_ticket_category_id',
  'discord_steward_role_id',
  'discord_incident_channel_id',
  'discord_transcript_channel_id',
  'discord_appeals_channel_id',
] as const

const EDITABLE_TEXT = [...DISCORD_FIELDS, 'currency_code'] as const
const PITBOSS_STATUSES = ['active', 'trial', 'inactive']

async function guard(leagueId: string | null | undefined) {
  const driver = await getAuthedDriver()
  if (!driver) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!leagueId || !UUID_RE.test(leagueId)) {
    return { error: NextResponse.json({ error: 'A valid league_id is required' }, { status: 400 }) }
  }
  if (!(await isPitbossLeagueAdmin(driver.id, leagueId))) {
    return {
      error: NextResponse.json(
        { error: 'Only league owners, co-owners and commissioners can use setup' },
        { status: 403 }
      ),
    }
  }
  return { driver }
}

export async function GET(req: NextRequest) {
  const leagueId = req.nextUrl.searchParams.get('league_id')
  const g = await guard(leagueId)
  if (g.error) return g.error

  const db = createAdminClient()
  const pb = () => db.schema('pitboss')

  const { data: league, error: leagueErr } = await db
    .schema('rise_os')
    .from('leagues')
    .select(
      'id, name, slug, sport, logo_url, is_public, pitboss_status, currency_code, discord_server_id, discord_ticket_category_id, discord_steward_role_id, discord_incident_channel_id, discord_transcript_channel_id, discord_appeals_channel_id'
    )
    .eq('id', leagueId!)
    .maybeSingle()
  if (leagueErr) return NextResponse.json({ error: leagueErr.message }, { status: 500 })
  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 })

  const count = async (p: PromiseLike<{ count: number | null; error: any }>) => {
    const { count: n, error } = await p
    return error ? 0 : n ?? 0
  }

  const [
    admins,
    drivers,
    roleMap,
    rulebooks,
    articles,
    certRoles,
    franchises,
    teamRoles,
    points,
    finance,
    signups,
    guardian,
  ] = await Promise.all([
    count(
      pb().from('driver_leagues').select('driver_id', { count: 'exact', head: true })
        .eq('league_id', leagueId!).or('is_commissioner.eq.true,is_owner.eq.true,is_co_owner.eq.true')
    ),
    count(
      pb().from('driver_leagues').select('driver_id', { count: 'exact', head: true })
        .eq('league_id', leagueId!).or('is_driver.eq.true,role.eq.driver')
    ),
    count(pb().from('league_role_map').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(pb().from('rule_books').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(
      pb().from('rule_articles').select('id', { count: 'exact', head: true })
        .eq('league_id', leagueId!).eq('active', true)
    ),
    count(pb().from('role_requirements').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(db.schema('rise_os').from('franchises').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(pb().from('league_team_roles').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(pb().from('league_points_table').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(pb().from('league_financial_config').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    count(pb().from('signup_rounds').select('id', { count: 'exact', head: true }).eq('league_id', leagueId!)),
    league.discord_server_id
      ? count(
          pb().from('guardian_guild_config').select('guild_id', { count: 'exact', head: true })
            .eq('guild_id', league.discord_server_id)
        )
      : Promise.resolve(0),
  ])

  const channelFields = DISCORD_FIELDS.filter((f) => f !== 'discord_server_id')
  const channelsSet = channelFields.filter((f) => !!(league as any)[f]).length

  const basicsMissing = [
    !league.name && 'name',
    !league.slug && 'slug',
    !league.sport && 'sport',
    !league.logo_url && 'logo',
  ].filter(Boolean) as string[]

  const checks: Check[] = [
    {
      id: 'basics',
      group: 'Basics',
      label: 'League profile',
      description: 'Name, slug, sport and logo shown on the join and cert pages.',
      status: basicsMissing.length === 0 ? 'done' : basicsMissing.length < 4 ? 'partial' : 'todo',
      detail: basicsMissing.length === 0 ? 'Complete' : `Missing: ${basicsMissing.join(', ')}`,
      required: true,
    },
    {
      id: 'currency',
      group: 'Basics',
      label: 'Currency',
      description: 'Currency code used for wallets, contracts and fines.',
      status: league.currency_code ? 'done' : 'todo',
      detail: league.currency_code ? league.currency_code : 'Not set',
      required: false,
      fields: ['currency_code'],
    },
    {
      id: 'discord_server',
      group: 'Discord',
      label: 'Discord server linked',
      description: 'The server ID PitBoss runs in. Required for roles, tickets and sign-ups.',
      status: league.discord_server_id ? 'done' : 'todo',
      detail: league.discord_server_id ? `Server ${league.discord_server_id}` : 'Not linked',
      required: true,
      fields: ['discord_server_id'],
    },
    {
      id: 'discord_channels',
      group: 'Discord',
      label: 'Steward channels & roles',
      description: 'Ticket category, steward role, incident, transcript and appeals channels.',
      status: channelsSet === channelFields.length ? 'done' : channelsSet > 0 ? 'partial' : 'todo',
      detail: `${channelsSet} of ${channelFields.length} configured`,
      required: true,
      fields: [...channelFields],
    },
    {
      id: 'guardian',
      group: 'Discord',
      label: 'Anti-raid protection (pitboss-guardian)',
      description: 'The Guardian bot must be in the server and have provisioned its config.',
      status: guardian > 0 ? 'done' : 'todo',
      detail: !league.discord_server_id
        ? 'Link the Discord server first'
        : guardian > 0
        ? 'Guardian active in this server'
        : 'Guardian has not registered this server — invite the bot',
      required: false,
    },
    {
      id: 'admins',
      group: 'People',
      label: 'League leadership',
      description: 'At least one commissioner, owner or co-owner on the league.',
      status: admins > 0 ? 'done' : 'todo',
      detail: `${admins} leader${admins === 1 ? '' : 's'}`,
      required: true,
    },
    {
      id: 'role_map',
      group: 'People',
      label: 'Discord role mapping',
      description: 'Maps Discord roles to PitBoss flags (driver, steward, commissioner…).',
      status: roleMap > 0 ? 'done' : 'todo',
      detail: `${roleMap} role${roleMap === 1 ? '' : 's'} mapped`,
      required: true,
    },
    {
      id: 'drivers',
      group: 'People',
      label: 'Drivers imported',
      description: 'Drivers synced from Discord into the league.',
      status: drivers > 0 ? 'done' : 'todo',
      detail: `${drivers} driver${drivers === 1 ? '' : 's'}`,
      required: true,
      href: '/pitboss/drivers?league_id={leagueId}',
    },
    {
      id: 'rulebook',
      group: 'Rules & Certification',
      label: 'Rulebook',
      description: 'A rulebook uploaded and parsed into articles stewards can cite.',
      status: rulebooks > 0 && articles > 0 ? 'done' : rulebooks > 0 ? 'partial' : 'todo',
      detail:
        rulebooks === 0
          ? 'No rulebook'
          : `${rulebooks} rulebook${rulebooks === 1 ? '' : 's'}, ${articles} active article${articles === 1 ? '' : 's'}`,
      required: true,
      href: '/pitboss/admin?league_id={leagueId}',
    },
    {
      id: 'cert_roles',
      group: 'Rules & Certification',
      label: 'Certification roles',
      description: 'Role exams (e.g. DRV, STW) with question counts and pass marks.',
      status: certRoles > 0 ? 'done' : 'todo',
      detail: `${certRoles} role${certRoles === 1 ? '' : 's'} configured`,
      required: false,
      href: '/pitboss/cert/admin?league_id={leagueId}',
    },
    {
      id: 'teams',
      group: 'Competition',
      label: 'Teams / franchises',
      description: 'Teams exist and are linked to their Discord team roles.',
      status:
        franchises > 0 && teamRoles > 0 ? 'done' : franchises > 0 || teamRoles > 0 ? 'partial' : 'todo',
      detail: `${franchises} franchise${franchises === 1 ? '' : 's'}, ${teamRoles} team role${teamRoles === 1 ? '' : 's'} linked`,
      required: true,
    },
    {
      id: 'points',
      group: 'Competition',
      label: 'Points system',
      description: 'Points per finishing position, plus fastest-lap, pole and sprint bonuses.',
      status: points > 0 ? 'done' : 'todo',
      detail: `${points} position${points === 1 ? '' : 's'} defined`,
      required: true,
    },
    {
      id: 'finance',
      group: 'Competition',
      label: 'Financial rules (cap league)',
      description: 'Soft cap, hard apron, DDV and tax bands. Skip for leagues without a cap.',
      status: finance > 0 ? 'done' : 'todo',
      detail: finance > 0 ? `${finance} division config${finance === 1 ? '' : 's'}` : 'Not configured',
      required: false,
      href: '/pitboss/admin/cap-status?league={slug}',
    },
    {
      id: 'signups',
      group: 'Competition',
      label: 'Sign-up round',
      description: 'A sign-up round has been opened at least once.',
      status: signups > 0 ? 'done' : 'todo',
      detail: `${signups} round${signups === 1 ? '' : 's'}`,
      required: false,
    },
    {
      id: 'live',
      group: 'Go live',
      label: 'PitBoss status & visibility',
      description: 'Set status to Active (or Trial) and make the league public.',
      status:
        league.pitboss_status !== 'inactive' && league.is_public
          ? 'done'
          : league.pitboss_status !== 'inactive' || league.is_public
          ? 'partial'
          : 'todo',
      detail: `Status: ${league.pitboss_status ?? 'unset'} · ${league.is_public ? 'Public' : 'Private'}`,
      required: true,
      fields: ['pitboss_status', 'is_public'],
    },
  ]

  const required = checks.filter((c) => c.required)
  const score = required.reduce((s, c) => s + (c.status === 'done' ? 1 : c.status === 'partial' ? 0.5 : 0), 0)

  return NextResponse.json({
    league: {
      id: league.id,
      name: league.name,
      slug: league.slug,
      pitboss_status: league.pitboss_status,
      is_public: league.is_public,
      currency_code: league.currency_code,
      discord_server_id: league.discord_server_id,
      discord_ticket_category_id: league.discord_ticket_category_id,
      discord_steward_role_id: league.discord_steward_role_id,
      discord_incident_channel_id: league.discord_incident_channel_id,
      discord_transcript_channel_id: league.discord_transcript_channel_id,
      discord_appeals_channel_id: league.discord_appeals_channel_id,
    },
    checks,
    progress: {
      requiredTotal: required.length,
      requiredDone: required.filter((c) => c.status === 'done').length,
      percent: Math.round((score / required.length) * 100),
    },
  })
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const g = await guard(body.league_id)
  if (g.error) return g.error

  const update: Record<string, any> = {}

  for (const f of EDITABLE_TEXT) {
    if (!(f in body)) continue
    const v = typeof body[f] === 'string' ? body[f].trim() : body[f]
    if (v === '' || v === null) {
      update[f] = null
    } else if (f === 'currency_code') {
      if (!/^[A-Za-z]{3}$/.test(v)) {
        return NextResponse.json({ error: 'currency_code must be a 3-letter code' }, { status: 400 })
      }
      update[f] = v.toUpperCase()
    } else {
      if (!SNOWFLAKE_RE.test(v)) {
        return NextResponse.json({ error: `${f} must be a Discord ID (digits only)` }, { status: 400 })
      }
      update[f] = v
    }
  }

  if ('pitboss_status' in body) {
    if (!PITBOSS_STATUSES.includes(body.pitboss_status)) {
      return NextResponse.json({ error: 'pitboss_status must be active, trial or inactive' }, { status: 400 })
    }
    update.pitboss_status = body.pitboss_status
  }
  if ('is_public' in body) {
    if (typeof body.is_public !== 'boolean') {
      return NextResponse.json({ error: 'is_public must be a boolean' }, { status: 400 })
    }
    update.is_public = body.is_public
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()
  const { error } = await db
    .schema('rise_os')
    .from('leagues')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', body.league_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, updated: Object.keys(update) })
}
