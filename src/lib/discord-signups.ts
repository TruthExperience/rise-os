// src/lib/discord-signups.ts
// Season signup DMs for PitBoss. Owners/co-owners/commissioners open a signup
// round for a season, the bot DMs every league member with a Discord ID, and
// members answer with Sign Up / No Thanks buttons. Results land in
// pitboss.league_signups, tied to the season via pitboss.signup_rounds.season_id.

import { supabaseAdmin } from '@/lib/supabase/admin'

const DISCORD_API = 'https://discord.com/api/v10'
const SEND_DELAY_MS = 1100 // keeps well under Discord's DM rate limits

const db = () => supabaseAdmin.schema('pitboss')
const riseOs = () => supabaseAdmin.schema('rise_os')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------

async function discord(path: string, body: unknown, attempt = 0): Promise<any> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.PITBOSS_DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.status === 429 && attempt < 3) {
    const json = await res.json().catch(() => ({}))
    await sleep(Math.ceil((json.retry_after ?? 1) * 1000) + 250)
    return discord(path, body, attempt + 1)
  }

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.message ?? `Discord ${res.status}`) as Error & {
      code?: number
    }
    err.code = json.code // 50007 = cannot send messages to this user
    throw err
  }
  return json
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function canOpenSignups(
  discordId: string,
  leagueId: string
): Promise<boolean> {
  const { data: driver } = await db()
    .from('drivers')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle()
  if (!driver) return false

  const { data: dl } = await db()
    .from('driver_leagues')
    .select('is_owner, is_co_owner, is_commissioner')
    .eq('driver_id', driver.id)
    .eq('league_id', leagueId)
    .maybeSingle()

  return !!(dl?.is_owner || dl?.is_co_owner || dl?.is_commissioner)
}

// ---------------------------------------------------------------------------
// Rounds (one open round per season)
// ---------------------------------------------------------------------------

export type OpenRoundResult =
  | {
      ok: true
      roundId: string
      seasonId: string
      seasonName: string
      invited: number
      skippedAlreadySignedUp: number
    }
  | { ok: false; error: string }

export async function openSignupRound(params: {
  leagueId: string
  openedByDiscordId: string
  seasonId?: string // omit to use the league's latest "upcoming" season
  message?: string // optional custom DM text
}): Promise<OpenRoundResult> {
  const { leagueId, openedByDiscordId, seasonId, message } = params

  if (!(await canOpenSignups(openedByDiscordId, leagueId))) {
    return { ok: false, error: 'Only league owners can open season signups.' }
  }

  // Resolve the season
  let seasonQuery = riseOs()
    .from('seasons')
    .select('id, name, status, season_number')
    .eq('league_id', leagueId)

  seasonQuery = seasonId
    ? seasonQuery.eq('id', seasonId)
    : seasonQuery.eq('status', 'upcoming').order('season_number', { ascending: false })

  const { data: season } = await seasonQuery.limit(1).maybeSingle()
  if (!season) {
    return {
      ok: false,
      error: seasonId
        ? 'That season was not found in this league.'
        : 'No upcoming season found for this league. Create the season first.',
    }
  }
  if (season.status === 'completed') {
    return { ok: false, error: `${season.name} is already completed.` }
  }

  const { data: existing } = await db()
    .from('signup_rounds')
    .select('id')
    .eq('season_id', season.id)
    .eq('status', 'open')
    .maybeSingle()
  if (existing) {
    return {
      ok: false,
      error: `Signups are already open for ${season.name}. Close that round first.`,
    }
  }

  const { data: opener } = await db()
    .from('drivers')
    .select('id')
    .eq('discord_id', openedByDiscordId)
    .maybeSingle()

  const { data: round, error: roundErr } = await db()
    .from('signup_rounds')
    .insert({
      league_id: leagueId,
      season_id: season.id,
      name: season.name,
      message: message ?? null,
      opened_by: opener?.id ?? null,
    })
    .select('id')
    .single()
  if (roundErr || !round) {
    return { ok: false, error: roundErr?.message ?? 'Could not create round.' }
  }

  // Members with a Discord ID
  const { data: members, error: memberErr } = await db()
    .from('driver_leagues')
    .select('driver_id, drivers!inner(discord_id)')
    .eq('league_id', leagueId)
    .not('drivers.discord_id', 'is', null)
  if (memberErr) return { ok: false, error: memberErr.message }

  // Skip anyone who already signed up for this season in an earlier round
  const { data: priorRounds } = await db()
    .from('signup_rounds')
    .select('id')
    .eq('season_id', season.id)
    .neq('id', round.id)
  const priorIds = (priorRounds ?? []).map((r) => r.id)

  let alreadySignedUp = new Set<string>()
  if (priorIds.length) {
    const { data: done } = await db()
      .from('league_signups')
      .select('driver_id')
      .in('round_id', priorIds)
      .eq('status', 'signed_up')
    alreadySignedUp = new Set((done ?? []).map((d) => d.driver_id))
  }

  const all = members ?? []
  const rows = all
    .filter((m: any) => !alreadySignedUp.has(m.driver_id))
    .map((m: any) => ({
      round_id: round.id,
      league_id: leagueId,
      driver_id: m.driver_id,
    }))

  if (rows.length) {
    const { error: insertErr } = await db()
      .from('league_signups')
      .upsert(rows, { onConflict: 'round_id,driver_id', ignoreDuplicates: true })
    if (insertErr) return { ok: false, error: insertErr.message }
  }

  return {
    ok: true,
    roundId: round.id,
    seasonId: season.id,
    seasonName: season.name,
    invited: rows.length,
    skippedAlreadySignedUp: all.length - rows.length,
  }
}

export async function closeSignupRound(roundId: string) {
  await db()
    .from('signup_rounds')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', roundId)
}

// ---------------------------------------------------------------------------
// Sending DMs (call repeatedly until remaining === 0)
// ---------------------------------------------------------------------------

export async function sendPendingDms(
  roundId: string,
  budgetMs = 45_000
): Promise<{ sent: number; failed: number; remaining: number }> {
  const started = Date.now()

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, message, status, leagues!inner(name)')
    .eq('id', roundId)
    .single()
  if (!round || round.status !== 'open') {
    return { sent: 0, failed: 0, remaining: 0 }
  }

  const leagueName = (round as any).leagues?.name ?? 'the league'
  const content =
    round.message?.trim() ||
    `**${leagueName}: ${round.name}**\nSeason signups are open. Do you want to race this season?`

  const { data: pending } = await db()
    .from('league_signups')
    .select('id, driver_id, drivers!inner(discord_id)')
    .eq('round_id', roundId)
    .eq('status', 'invited')
    .is('dm_message_id', null)

  let sent = 0
  let failed = 0
  const queue = pending ?? []

  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - started > budgetMs) {
      return { sent, failed, remaining: queue.length - i }
    }

    const row: any = queue[i]
    const discordId = row.drivers?.discord_id as string | undefined
    if (!discordId) continue

    try {
      const channel = await discord('/users/@me/channels', {
        recipient_id: discordId,
      })
      const msg = await discord(`/channels/${channel.id}/messages`, {
        content,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3, // green
                label: 'Sign Up',
                custom_id: `signup:${roundId}:yes`,
              },
              {
                type: 2,
                style: 2, // grey
                label: 'No Thanks',
                custom_id: `signup:${roundId}:no`,
              },
            ],
          },
        ],
      })

      await db()
        .from('league_signups')
        .update({ dm_channel_id: channel.id, dm_message_id: msg.id })
        .eq('id', row.id)
      sent++
    } catch (e: any) {
      await db()
        .from('league_signups')
        .update({
          status: 'dm_failed',
          error: e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e),
        })
        .eq('id', row.id)
      failed++
    }

    await sleep(SEND_DELAY_MS)
  }

  return { sent, failed, remaining: 0 }
}

// ---------------------------------------------------------------------------
// Button handler: return value is the interaction response body
// (type 7 = update the DM in place). Returns null if not a signup button.
// ---------------------------------------------------------------------------

export async function handleSignupButton(
  customId: string,
  discordUserId: string
): Promise<{ type: number; data: { content: string; components: [] } } | null> {
  const [prefix, roundId, answer] = customId.split(':')
  if (prefix !== 'signup' || !roundId || !['yes', 'no'].includes(answer)) {
    return null
  }

  const reply = (content: string) => ({
    type: 7,
    data: { content, components: [] as [] },
  })

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, status, leagues!inner(name)')
    .eq('id', roundId)
    .single()
  if (!round || round.status !== 'open') {
    return reply('Signups for this season are closed.')
  }

  const { data: driver } = await db()
    .from('drivers')
    .select('id')
    .eq('discord_id', discordUserId)
    .maybeSingle()
  if (!driver) return reply('I could not find your driver profile.')

  const status = answer === 'yes' ? 'signed_up' : 'declined'
  const { error } = await db()
    .from('league_signups')
    .update({ status, responded_at: new Date().toISOString() })
    .eq('round_id', roundId)
    .eq('driver_id', driver.id)
  if (error) return reply('Something went wrong saving your answer. Try again.')

  const leagueName = (round as any).leagues?.name ?? 'the league'
  return reply(
    status === 'signed_up'
      ? `You are signed up for **${leagueName}: ${round.name}**.`
      : `Got it, you are not signing up for **${leagueName}: ${round.name}**.`
  )
}

// ---------------------------------------------------------------------------
// Season-wide helpers + summary for a status command
// ---------------------------------------------------------------------------

// Every round id that belongs to the same season as the given round. Used so
// signups made in an earlier (closed) round still count after a round is
// closed and reopened for the same season.
export async function seasonRoundIds(roundId: string): Promise<string[]> {
  const { data: r } = await db()
    .from('signup_rounds')
    .select('season_id')
    .eq('id', roundId)
    .single()
  if (!r?.season_id) return [roundId]

  const { data } = await db()
    .from('signup_rounds')
    .select('id')
    .eq('season_id', r.season_id)
  return (data ?? []).map((x) => x.id)
}

export async function signupSummary(roundId: string) {
  const { data } = await db()
    .from('league_signups')
    .select('status, driver_id')
    .eq('round_id', roundId)

  const counts = { invited: 0, signed_up: 0, declined: 0, dm_failed: 0 }
  const signed = new Set<string>()
  for (const r of data ?? []) {
    if (r.status === 'signed_up') signed.add(r.driver_id)
    else counts[r.status as keyof typeof counts]++
  }

  // Add anyone who signed up in an earlier round of the same season
  const ids = await seasonRoundIds(roundId)
  const { data: all } = await db()
    .from('league_signups')
    .select('driver_id')
    .in('round_id', ids)
    .eq('status', 'signed_up')
  for (const a of all ?? []) signed.add(a.driver_id)

  counts.signed_up = signed.size
  return counts
}
