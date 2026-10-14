// src/lib/discord-signups.ts
// Season signup DMs for PitBoss. Owners/co-owners/commissioners open a signup
// round for a season, the bot DMs every league member with a Discord ID, and
// members answer with Sign Up / No Thanks buttons. Results land in
// pitboss.league_signups, tied to the season via pitboss.signup_rounds.season_id.
//
// Owners can also invite ONE racer to the open round (sendIndividualInvite),
// which saves exactly like a normal signup.
//
// Owners can request pictures of specific tracks (time trial screenshots) as
// part of signup. This is optional per round: leave `tracks` off when a season
// doesn't need them (e.g. VRC season 2) and set it when it does (season 3).
// Drivers send them to the bot with /signup photos, from the invite DM, and
// the bot posts them into the league's signup channel
// (pitboss.leagues.signup_channel_id).
//
// Team requests: after tapping Sign Up, a driver picks up to three teams in
// order of preference (button taps, one message per choice). Picks land in
// pitboss.signup_team_choices and, once the driver finishes, each team's
// principal(s) get a DM. Where the teams come from (see leagueTeamOptions):
//   1. pitboss.signup_team_options, scoped to ONE season number (a league can
//      offer teams for season 2 only, with a default principal per team)
//   2. otherwise pitboss.team_rosters (latest season on file for the league)
// No teams from either source = no team step.

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

// Interaction response body returned to the router (type 7 = update in place).
export type ButtonResponse = {
  type: number
  data: { content: string; components: any[] }
}

// ---------------------------------------------------------------------------
// Signup channel (per league)
// ---------------------------------------------------------------------------

// Where test responses and signup screenshots are posted for a league. Read
// from pitboss.leagues.signup_channel_id. Returns null when the league has no
// channel set, in which case nothing is posted to a channel.
export async function signupChannelId(leagueId: string): Promise<string | null> {
  const { data, error } = await db()
    .from('leagues')
    .select('signup_channel_id')
    .eq('id', leagueId)
    .maybeSingle()
  if (error) {
    console.error('[signups] signup channel lookup failed:', error)
    return null
  }
  return ((data as any)?.signup_channel_id as string | null | undefined) || null
}

// ---------------------------------------------------------------------------
// Requested tracks (time trial pictures)
// ---------------------------------------------------------------------------

// /signup photos takes up to three images, so at most three tracks.
export const MAX_REQUESTED_TRACKS = 3

// The track-request block always starts with this phrase. It is how the bot
// recognises, from a round's saved invite text, that pictures were requested
// and which tracks (see requestedTracksFromMessage).
const REQUEST_MARKER = 'As part of signups, please send a picture'

function trackRequestBlock(tracks: string[]): string {
  const subject = tracks.length === 1 ? 'this track' : 'each of these tracks'
  return (
    `${REQUEST_MARKER} of ${subject}. Once you've tapped **Sign Up**, send them ` +
    `to me right here in this DM with \`/signup photos\` (attach up to ` +
    `${MAX_REQUESTED_TRACKS} images) and I'll post them for the league:\n` +
    tracks.map((t, i) => `${i + 1}. ${t}`).join('\n')
  )
}

// Reads the requested tracks back out of a round's saved invite text. Returns
// [] when the round didn't request any.
export function requestedTracksFromMessage(
  message: string | null | undefined
): string[] {
  if (!message) return []
  const at = message.indexOf(REQUEST_MARKER)
  if (at === -1) return []
  return message
    .slice(at)
    .split('\n')
    .map((line) => line.match(/^\d+\.\s+(.+)$/)?.[1]?.trim())
    .filter((t): t is string => !!t)
}

// Turns the owner's `tracks` option ("Monza, Suzuka; Spa") into a clean list:
// split on commas / semicolons / new lines, trimmed, de-duplicated, max 3.
export function parseTracks(input: string | null | undefined): string[] {
  if (!input) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(/[;,\n]/)) {
    const t = raw.trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length === MAX_REQUESTED_TRACKS) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Team requests
// ---------------------------------------------------------------------------

export const MAX_TEAM_CHOICES = 3
const ORDINAL = ['1st', '2nd', '3rd']

export interface TeamOption {
  id: string // pitboss.car_class_teams.id
  name: string
  principalDiscordIds: string[]
}

// The season number a signup round belongs to (rise_os.seasons.season_number),
// or null if it can't be worked out.
async function seasonNumberForSeasonId(
  seasonId: string | null | undefined
): Promise<number | null> {
  if (!seasonId) return null
  const { data } = await riseOs()
    .from('seasons')
    .select('season_number')
    .eq('id', seasonId)
    .maybeSingle()
  const n = (data as any)?.season_number
  return typeof n === 'number' ? n : null
}

// Teams a driver can request in this league, plus each team's principal(s).
//
// `seasonId` is the season of the round being answered. When omitted it is
// taken from the league's newest open round (the /signups open summary calls
// it without one, right after opening a round).
//
// 1. pitboss.signup_team_options rows for THIS season number only. This is how
//    a league offers teams for one season (e.g. VRC season 2) with a default
//    principal per team, without a team_rosters row per team. A different
//    season number gets nothing from this table.
// 2. Otherwise pitboss.team_rosters, using the latest season on file for the
//    league (the original behaviour).
// Returns [] when neither has anything, and the team step is skipped.
export async function leagueTeamOptions(
  leagueId: string,
  seasonId?: string | null
): Promise<TeamOption[]> {
  let effectiveSeasonId = seasonId ?? null
  if (!effectiveSeasonId) {
    const { data: openRound } = await db()
      .from('signup_rounds')
      .select('season_id')
      .eq('league_id', leagueId)
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    effectiveSeasonId = (openRound as any)?.season_id ?? null
  }

  // 1. League-level options for this season only.
  const seasonNumber = await seasonNumberForSeasonId(effectiveSeasonId)
  if (seasonNumber !== null) {
    const { data: optionRows } = await db()
      .from('signup_team_options')
      .select('car_class_team_id, principal_discord_id')
      .eq('league_id', leagueId)
      .eq('season_number', seasonNumber)
    const options: any[] = optionRows ?? []

    if (options.length > 0) {
      const optionTeamIds = Array.from(
        new Set(options.map((o) => o.car_class_team_id as string))
      )
      const { data: optionTeams } = await db()
        .from('car_class_teams')
        .select('id, team_name, short_name')
        .in('id', optionTeamIds)

      return ((optionTeams ?? []) as any[])
        .map((t) => ({
          id: t.id as string,
          name: ((t.team_name || t.short_name || 'Unknown team') as string).slice(0, 80),
          principalDiscordIds: Array.from(
            new Set(
              options
                .filter((o) => o.car_class_team_id === t.id && o.principal_discord_id)
                .map((o) => o.principal_discord_id as string)
            )
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  }

  // 2. Fall back to rosters.
  const { data: rosterRows } = await db()
    .from('team_rosters')
    .select('driver_id, car_class_team_id, season, is_team_principal')
    .eq('league_id', leagueId)
  const rosters: any[] = rosterRows ?? []
  if (rosters.length === 0) return []

  const seasonKey = (r: any) => String(r.season ?? '')
  const latest = rosters
    .map(seasonKey)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop()
  const current = rosters.filter(
    (r) => seasonKey(r) === latest && r.car_class_team_id
  )

  const teamIds = Array.from(new Set(current.map((r) => r.car_class_team_id as string)))
  if (teamIds.length === 0) return []

  const principalRows = current.filter((r) => r.is_team_principal)
  const principalIds = Array.from(
    new Set(principalRows.map((r) => r.driver_id as string))
  )

  const { data: teams } = await db()
    .from('car_class_teams')
    .select('id, team_name, short_name')
    .in('id', teamIds)

  const discordByDriver = new Map<string, string>()
  if (principalIds.length) {
    const { data: principalDrivers } = await db()
      .from('drivers')
      .select('id, discord_id')
      .in('id', principalIds)
    for (const d of (principalDrivers ?? []) as any[]) {
      if (d.discord_id) discordByDriver.set(d.id, d.discord_id)
    }
  }

  return ((teams ?? []) as any[])
    .map((t) => ({
      id: t.id as string,
      name: ((t.team_name || t.short_name || 'Unknown team') as string).slice(0, 80),
      principalDiscordIds: Array.from(
        new Set(
          principalRows
            .filter((r) => r.car_class_team_id === t.id)
            .map((r) => discordByDriver.get(r.driver_id))
            .filter((id): id is string => !!id)
        )
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// One message per choice: a button per team (minus teams already picked) and a
// "no preference" / "that's all" button. Discord allows 25 buttons per message,
// so at most 24 teams are shown.
function teamPrompt(
  roundId: string,
  rank: number,
  teams: TeamOption[],
  chosenIds: string[]
): { content: string; components: any[] } {
  const remaining = teams.filter((t) => !chosenIds.includes(t.id)).slice(0, 24)

  const buttons: any[] = remaining.map((t) => ({
    type: 2,
    style: 2, // grey
    label: t.name,
    custom_id: `signupteam:${roundId}:${rank}:${t.id}`,
  }))
  buttons.push({
    type: 2,
    style: 1, // blurple
    label: rank === 1 ? 'No preference' : "That's all",
    custom_id: `signupteam:${roundId}:${rank}:none`,
  })

  const components: any[] = []
  for (let i = 0; i < buttons.length; i += 5) {
    components.push({ type: 1, components: buttons.slice(i, i + 5) })
  }

  const content =
    rank === 1
      ? `**Team request** — which team would you like to drive for? Tap your **1st choice**. ` +
        `You can add up to ${MAX_TEAM_CHOICES} in order of preference.`
      : `Got it. Tap your **${ORDINAL[rank - 1]} choice**, or **That's all** to send your requests.`

  return { content, components }
}

// Sends the driver's picks to each team's principal (one DM per principal per
// driver), marks them notified, and returns the text shown back to the driver.
async function finalizeTeamChoices(params: {
  round: any
  driver: any
  discordUserId: string
  teams: TeamOption[]
}): Promise<string> {
  const { round, driver, discordUserId, teams } = params

  const { data: picks } = await db()
    .from('signup_team_choices')
    .select('id, choice_rank, car_class_team_id, principal_notified_at')
    .eq('round_id', round.id)
    .eq('driver_id', driver.id)
    .order('choice_rank')
  const rows: any[] = picks ?? []
  if (rows.length === 0) return "No team preference noted. You're all set."

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? 'Unknown team'
  const summary = rows
    .map((r) => `${ORDINAL[r.choice_rank - 1]}: ${teamName(r.car_class_team_id)}`)
    .join('\n')

  // Only picks the principals haven't been told about yet
  const fresh = rows.filter((r) => !r.principal_notified_at)
  const byPrincipal = new Map<string, { team: string; rank: number }[]>()
  for (const r of fresh) {
    const team = teams.find((t) => t.id === r.car_class_team_id)
    for (const pid of team?.principalDiscordIds ?? []) {
      if (pid === discordUserId) continue // don't DM someone about themselves
      const list = byPrincipal.get(pid) ?? []
      list.push({ team: team!.name, rank: r.choice_rank })
      byPrincipal.set(pid, list)
    }
  }

  const leagueName = (round as any).leagues?.name ?? 'the league'
  const name = driver.display_name || driver.discord_username || 'A driver'
  const fullList = rows
    .map((r) => `${r.choice_rank}. ${teamName(r.car_class_team_id)}`)
    .join(' · ')

  const results = await Promise.allSettled(
    Array.from(byPrincipal.entries()).map(async ([principalId, entries]) => {
      const content =
        `🏁 **${leagueName}: ${round.name}** — team request\n` +
        `**${name}** (<@${discordUserId}>) signed up and asked to drive for your team:\n` +
        entries.map((e) => `• **${e.team}** — ${ORDINAL[e.rank - 1]} choice`).join('\n') +
        `\nTheir full list: ${fullList}`
      const channel = await discord('/users/@me/channels', { recipient_id: principalId })
      await discord(`/channels/${channel.id}/messages`, {
        content,
        allowed_mentions: { parse: [] },
      })
    })
  )
  const reached = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.length - reached
  for (const r of results) {
    if (r.status === 'rejected') console.error('[signupteam] principal DM failed:', r.reason)
  }

  if (fresh.length > 0) {
    await db()
      .from('signup_team_choices')
      .update({ principal_notified_at: new Date().toISOString() })
      .in('id', fresh.map((r) => r.id))
  }

  let note: string
  if (byPrincipal.size === 0) {
    note = fresh.length > 0 ? "I couldn't find a team principal to notify, but league owners can see your picks." : ''
  } else if (failed === 0) {
    note = `Team principal${reached === 1 ? '' : 's'} notified.`
  } else {
    note = `Notified ${reached} of ${byPrincipal.size} team principals (${failed} couldn't be reached).`
  }

  return `**Your team requests**\n${summary}${note ? `\n\n${note}` : ''}`
}

async function handleTeamButton(
  roundId: string,
  rankStr: string,
  teamId: string,
  discordUserId: string
): Promise<ButtonResponse> {
  const reply = (content: string, components: any[] = []): ButtonResponse => ({
    type: 7,
    data: { content, components },
  })

  const rank = Number(rankStr)
  if (!roundId || !teamId || !Number.isInteger(rank) || rank < 1 || rank > MAX_TEAM_CHOICES) {
    return reply('That choice is no longer valid.')
  }

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, status, league_id, season_id, leagues!inner(name)')
    .eq('id', roundId)
    .single()
  if (!round || round.status !== 'open') {
    return reply('Signups for this season are closed.')
  }

  const { data: driver } = await db()
    .from('drivers')
    .select('id, display_name, discord_username')
    .eq('discord_id', discordUserId)
    .maybeSingle()
  if (!driver) return reply('I could not find your driver profile.')

  // Team requests only count for drivers who tapped Sign Up (any round of the
  // season, same rule as the signup list).
  const roundIds = await seasonRoundIds(round.id)
  const { data: signedUp } = await db()
    .from('league_signups')
    .select('id')
    .eq('driver_id', driver.id)
    .eq('status', 'signed_up')
    .in('round_id', roundIds)
    .limit(1)
  if (!signedUp || signedUp.length === 0) {
    return reply('Tap **Sign Up** on your invite first, then pick your teams.')
  }

  const teams = await leagueTeamOptions(round.league_id, (round as any).season_id)

  if (teamId !== 'none') {
    if (!teams.some((t) => t.id === teamId)) {
      return reply("That team isn't available any more. Ask a league owner.")
    }

    // Replace this rank and anything after it, and drop the team if it was
    // already picked at another rank, so picks stay unique and ordered.
    await db()
      .from('signup_team_choices')
      .delete()
      .eq('round_id', roundId)
      .eq('driver_id', driver.id)
      .gte('choice_rank', rank)
    await db()
      .from('signup_team_choices')
      .delete()
      .eq('round_id', roundId)
      .eq('driver_id', driver.id)
      .eq('car_class_team_id', teamId)

    const { error } = await db().from('signup_team_choices').insert({
      round_id: roundId,
      league_id: round.league_id,
      driver_id: driver.id,
      choice_rank: rank,
      car_class_team_id: teamId,
    })
    if (error) {
      console.error('[signupteam] insert failed:', error)
      return reply('Something went wrong saving that pick. Tap your team again.')
    }

    const { data: chosen } = await db()
      .from('signup_team_choices')
      .select('car_class_team_id')
      .eq('round_id', roundId)
      .eq('driver_id', driver.id)
    const chosenIds = ((chosen ?? []) as any[]).map((c) => c.car_class_team_id as string)

    const stillAvailable = teams.filter((t) => !chosenIds.includes(t.id)).length
    if (rank < MAX_TEAM_CHOICES && stillAvailable > 0) {
      const next = teamPrompt(roundId, rank + 1, teams, chosenIds)
      const picked = chosenIds
        .map((id, i) => `${ORDINAL[i]}: ${teams.find((t) => t.id === id)?.name ?? 'Unknown team'}`)
        .join('\n')
      return reply(`${picked}\n\n${next.content}`, next.components)
    }
  }

  const text = await finalizeTeamChoices({ round, driver, discordUserId, teams })
  return reply(text)
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
  tracks?: string[] // optional: tracks to request pictures of (max 3)
}): Promise<OpenRoundResult> {
  const { leagueId, openedByDiscordId, seasonId, message } = params
  const tracks = (params.tracks ?? []).slice(0, MAX_REQUESTED_TRACKS)

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

  // The invite text every member is DM'd. With requested tracks, the pictures
  // block is added after the owner's custom text (or the default opener).
  let inviteMessage: string | null = message?.trim() ? message.trim() : null
  if (tracks.length > 0) {
    const { data: leagueRow } = await db()
      .from('leagues')
      .select('name')
      .eq('id', leagueId)
      .maybeSingle()
    const lead =
      inviteMessage ??
      `**${leagueRow?.name ?? 'the league'}: ${season.name}**\n` +
        `Season signups are open. Do you want to race this season?`
    inviteMessage = `${lead}\n\n${trackRequestBlock(tracks)}`
  }

  const { data: round, error: roundErr } = await db()
    .from('signup_rounds')
    .insert({
      league_id: leagueId,
      season_id: season.id,
      name: season.name,
      message: inviteMessage,
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
// Invite DM (shared by the bulk sender and the individual invite)
// ---------------------------------------------------------------------------

function defaultInviteContent(leagueName: string, roundName: string): string {
  return `**${leagueName}: ${roundName}**\nSeason signups are open. Do you want to race this season?`
}

// Sends one invite DM with the real Sign Up / No Thanks buttons for a round.
// Throws on Discord errors (err.code 50007 = the user has DMs closed).
async function sendInviteDm(
  roundId: string,
  discordId: string,
  content: string
): Promise<{ channelId: string; messageId: string }> {
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
  return { channelId: channel.id as string, messageId: msg.id as string }
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
    round.message?.trim() || defaultInviteContent(leagueName, round.name)

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
      const dm = await sendInviteDm(roundId, discordId, content)

      await db()
        .from('league_signups')
        .update({ dm_channel_id: dm.channelId, dm_message_id: dm.messageId })
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
// Individual invite: one racer, real signup (saved like any other signup)
// ---------------------------------------------------------------------------

export type IndividualInviteResult =
  | { ok: true; roundName: string; driverName: string; tracksRequested: number }
  | { ok: false; error: string }

// Invites ONE racer to the league's currently open round. Uses the round's own
// invite text (so track pictures are requested only if the round asked for
// them) and the real Sign Up / No Thanks buttons, so the answer is saved to
// pitboss.league_signups and counts in /signups status and /signups list.
// Works for racers who joined after the round opened. Re-sending to someone
// who declined or never answered resets their row to "invited".
export async function sendIndividualInvite(params: {
  leagueId: string
  invitedByDiscordId: string
  targetDiscordId: string
}): Promise<IndividualInviteResult> {
  const { leagueId, invitedByDiscordId, targetDiscordId } = params

  if (!(await canOpenSignups(invitedByDiscordId, leagueId))) {
    return { ok: false, error: 'Only league owners can send signup invites.' }
  }

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, message, season_id, leagues!inner(name)')
    .eq('league_id', leagueId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!round) {
    return {
      ok: false,
      error: 'No signup round is open for this league. Open one with `/signups open` first.',
    }
  }

  const { data: driver } = await db()
    .from('drivers')
    .select('id, display_name, discord_username')
    .eq('discord_id', targetDiscordId)
    .maybeSingle()
  if (!driver) {
    return {
      ok: false,
      error:
        `I can't find a driver record for <@${targetDiscordId}>. ` +
        `Run \`/members-sync\` first, or check they're in the league server.`,
    }
  }
  const driverName = driver.display_name || driver.discord_username || 'that driver'

  // Already signed up this season (any round of it)? Nothing to do.
  const roundIds = await seasonRoundIds(round.id)
  const { data: done } = await db()
    .from('league_signups')
    .select('id')
    .eq('driver_id', driver.id)
    .eq('status', 'signed_up')
    .in('round_id', roundIds)
    .limit(1)
  if (done && done.length > 0) {
    return { ok: false, error: `${driverName} has already signed up for ${round.name}.` }
  }

  // (Re)queue their row for this round
  const { error: upsertErr } = await db()
    .from('league_signups')
    .upsert(
      {
        round_id: round.id,
        league_id: leagueId,
        driver_id: driver.id,
        status: 'invited',
        dm_channel_id: null,
        dm_message_id: null,
        error: null,
        responded_at: null,
      },
      { onConflict: 'round_id,driver_id' }
    )
  if (upsertErr) return { ok: false, error: upsertErr.message }

  const leagueName = (round as any).leagues?.name ?? 'the league'
  const content =
    round.message?.trim() || defaultInviteContent(leagueName, round.name)

  try {
    const dm = await sendInviteDm(round.id, targetDiscordId, content)
    await db()
      .from('league_signups')
      .update({ dm_channel_id: dm.channelId, dm_message_id: dm.messageId })
      .eq('round_id', round.id)
      .eq('driver_id', driver.id)
  } catch (e: any) {
    const reason = e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e)
    await db()
      .from('league_signups')
      .update({ status: 'dm_failed', error: reason })
      .eq('round_id', round.id)
      .eq('driver_id', driver.id)
    return {
      ok: false,
      error: `Couldn't DM ${driverName} (${reason}). They may have DMs closed.`,
    }
  }

  return {
    ok: true,
    roundName: round.name,
    driverName,
    tracksRequested: requestedTracksFromMessage(round.message).length,
  }
}

// ---------------------------------------------------------------------------
// Test invite: one individual DM, no DB writes (works in any league)
// ---------------------------------------------------------------------------

// F1 25 base game + 2026 Season Pack (Madring). Three distinct circuits are
// drawn when the owner asks for `random`. Circuits with a reverse layout get a
// 50/50 flip.
const TRACK_POOL: { name: string; hasReverse?: boolean }[] = [
  { name: 'Albert Park Circuit (Melbourne)' },
  { name: 'Shanghai International Circuit' },
  { name: 'Suzuka Circuit' },
  { name: 'Bahrain International Circuit (Sakhir)' },
  { name: 'Jeddah Corniche Circuit' },
  { name: 'Miami International Autodrome' },
  { name: 'Autodromo Enzo e Dino Ferrari (Imola)' },
  { name: 'Circuit de Monaco' },
  { name: 'Circuit de Barcelona-Catalunya' },
  { name: 'Circuit Gilles Villeneuve (Montreal)' },
  { name: 'Red Bull Ring (Spielberg)', hasReverse: true },
  { name: 'Silverstone Circuit', hasReverse: true },
  { name: 'Circuit de Spa-Francorchamps' },
  { name: 'Hungaroring' },
  { name: 'Circuit Zandvoort', hasReverse: true },
  { name: 'Autodromo Nazionale Monza' },
  { name: 'Baku City Circuit' },
  { name: 'Marina Bay Street Circuit (Singapore)' },
  { name: 'Circuit of the Americas (Austin)' },
  { name: 'Autódromo Hermanos Rodríguez (Mexico City)' },
  { name: 'Autódromo José Carlos Pace (Interlagos)' },
  { name: 'Las Vegas Strip Circuit' },
  { name: 'Lusail International Circuit (Qatar)' },
  { name: 'Yas Marina Circuit (Abu Dhabi)' },
  { name: 'Madring (Madrid)' }, // 2026 Season Pack, 2026 cars only
]

function pickTracks(n = 3): string[] {
  const pool = [...TRACK_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n).map((t) =>
    t.hasReverse && Math.random() < 0.5 ? `${t.name} - Reverse` : t.name
  )
}

// Track pictures are optional, same as /signups open:
//   - `tracks` given        -> request those tracks
//   - `randomTracks: true`  -> request 3 random F1 25 tracks
//   - neither               -> plain invite, no pictures requested
export async function sendTestSignup(params: {
  leagueId: string
  openedByDiscordId: string
  targetDiscordId: string
  seasonNumber?: number // defaults to 2
  tracks?: string[] // owner-chosen tracks
  randomTracks?: boolean // draw 3 random tracks instead
}): Promise<{ ok: true; tracks: string[] } | { ok: false; error: string }> {
  const { leagueId, openedByDiscordId, targetDiscordId } = params
  const seasonNumber = params.seasonNumber ?? 2

  if (!(await canOpenSignups(openedByDiscordId, leagueId))) {
    return { ok: false, error: 'Only league owners can send test signups.' }
  }

  const { data: league } = await db()
    .from('leagues')
    .select('name')
    .eq('id', leagueId)
    .maybeSingle()

  const { data: driver } = await db()
    .from('drivers')
    .select('display_name, discord_username')
    .eq('discord_id', targetDiscordId)
    .maybeSingle()

  const name = driver?.display_name || driver?.discord_username || 'driver'
  const leagueName = league?.name ?? 'the league'
  const requested = (params.tracks ?? []).slice(0, MAX_REQUESTED_TRACKS)
  const tracks =
    requested.length > 0 ? requested : params.randomTracks ? pickTracks(3) : []

  const content =
    `**${leagueName}: Season ${seasonNumber} Driver Signup** *(test invite)*\n\n` +
    `Hi ${name}, we'd be delighted to have you on the grid for **Season ${seasonNumber}**. ` +
    `Your pace and sportsmanship have been a big part of what makes this league fun, ` +
    `and we'd love to see you back out there.\n\n` +
    `If you're in, tap **Sign Up** below.` +
    (tracks.length > 0 ? ` ${trackRequestBlock(tracks)}` : '') +
    `\n\nNot this time? Tap **No Thanks**, no hard feelings. Thanks for racing with us!`

  // custom_id: signuptest:<leagueId>:<season>:<yes|no>:<1 if pictures requested>
  const photosFlag = tracks.length > 0 ? '1' : '0'

  try {
    const channel = await discord('/users/@me/channels', {
      recipient_id: targetDiscordId,
    })
    await discord(`/channels/${channel.id}/messages`, {
      content,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Sign Up',
              custom_id: `signuptest:${leagueId}:${seasonNumber}:yes:${photosFlag}`,
            },
            {
              type: 2,
              style: 2,
              label: 'No Thanks',
              custom_id: `signuptest:${leagueId}:${seasonNumber}:no:${photosFlag}`,
            },
          ],
        },
      ],
    })
    return { ok: true, tracks }
  } catch (e: any) {
    return {
      ok: false,
      error: e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e),
    }
  }
}

// Test button clicks: reply in the DM and post the result to the league's
// signup channel (if it has one) so feedback lands where owners will see it.
// Nothing is saved to the DB. leagueId is null for old-format test buttons.
async function handleTestButton(
  leagueId: string | null,
  seasonNumber: string,
  answer: string,
  wantsPhotos: boolean,
  discordUserId: string
): Promise<ButtonResponse> {
  const signedUp = answer === 'yes'

  const channelId = leagueId ? await signupChannelId(leagueId) : null
  if (channelId) {
    try {
      await discord(`/channels/${channelId}/messages`, {
        content:
          `🧪 Test signup response: <@${discordUserId}> chose ` +
          `**${signedUp ? 'Sign Up' : 'No Thanks'}** for Season ${seasonNumber}. ` +
          `Nothing was saved.`,
        allowed_mentions: { parse: [] },
      })
    } catch (e) {
      console.error('[signuptest] channel post failed:', e)
    }
  }

  let content: string
  if (!signedUp) {
    content = `Got it, no problem *(test, nothing saved)*.`
  } else {
    content = `Thanks! You're signed up for Season ${seasonNumber} *(test, nothing saved)*.`
    if (wantsPhotos) {
      content +=
        ` In a real signup you'd now send your pictures right here in this DM ` +
        `with \`/signup photos\` (attach up to ${MAX_REQUESTED_TRACKS} images).`
    }
  }

  return { type: 7, data: { content, components: [] } }
}

// ---------------------------------------------------------------------------
// Button handler: return value is the interaction response body
// (type 7 = update the DM in place). Returns null if not a signup button.
// ---------------------------------------------------------------------------

export async function handleSignupButton(
  customId: string,
  discordUserId: string
): Promise<ButtonResponse | null> {
  const [prefix, roundId, answer, extra] = customId.split(':')

  // Team request taps: signupteam:<roundId>:<rank>:<teamId | none>
  if (prefix === 'signupteam') {
    return handleTeamButton(roundId, answer, extra, discordUserId)
  }

  // Test invites: no DB writes.
  //   new: signuptest:<leagueId>:<season>:<yes|no>:<1|0 pictures requested>
  //   old: signuptest:<season>:<yes|no>   (no league, so no channel post)
  if (prefix === 'signuptest') {
    const p = customId.split(':')
    const legacy = p.length === 3
    const leagueId = legacy ? null : p[1]
    const seasonNumber = legacy ? p[1] : p[2]
    const testAnswer = legacy ? p[2] : p[3]
    const wantsPhotos = legacy ? false : p[4] === '1'
    if (!seasonNumber || !['yes', 'no'].includes(testAnswer)) return null
    return handleTestButton(leagueId, seasonNumber, testAnswer, wantsPhotos, discordUserId)
  }

  if (prefix !== 'signup' || !roundId || !['yes', 'no'].includes(answer)) {
    return null
  }

  const reply = (content: string, components: any[] = []): ButtonResponse => ({
    type: 7,
    data: { content, components },
  })

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, status, message, league_id, season_id, leagues!inner(name)')
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
  if (status !== 'signed_up') {
    return reply(
      `Got it, you are not signing up for **${leagueName}: ${round.name}**.`
    )
  }

  // This reply replaces the invite, so repeat the requested tracks here and
  // start the team request step (if this season has teams on offer).
  const tracks = requestedTracksFromMessage((round as any).message)
  const teams = await leagueTeamOptions(round.league_id, (round as any).season_id)

  let content = `You are signed up for **${leagueName}: ${round.name}**.`
  if (tracks.length > 0) {
    content +=
      `\n\nNext, send a picture of ${tracks.length === 1 ? 'this track' : 'each of these tracks'} ` +
      `right here in this DM with \`/signup photos\` (attach up to ` +
      `${MAX_REQUESTED_TRACKS} images):\n` +
      tracks.map((t, i) => `${i + 1}. ${t}`).join('\n')
  }

  if (teams.length === 0) return reply(content)

  const prompt = teamPrompt(roundId, 1, teams, [])
  return reply(`${content}\n\n${prompt.content}`, prompt.components)
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
// ===========================================================================
// PASTE AT THE END of src/lib/discord-signups.ts (no new imports needed).
// Uses helpers already in that file: db, discord, sleep, SEND_DELAY_MS,
// REQUEST_MARKER, trackRequestBlock, defaultInviteContent, canOpenSignups,
// seasonRoundIds, MAX_REQUESTED_TRACKS.
// ===========================================================================

// ---------------------------------------------------------------------------
// Add / change the requested tracks on an ALREADY OPEN round
// ---------------------------------------------------------------------------

export type SetTracksResult =
  | {
      ok: true
      roundId: string
      roundName: string
      tracks: string[]
      replaced: boolean // true if the round already had a picture request
    }
  | { ok: false; error: string }

// Rewrites the track-request block in the open round's saved invite text.
// Nobody is re-invited and no signup rows change. Effects:
//   - anyone who taps Sign Up from now on is asked for the pictures (the
//     Sign Up reply reads the round's text at click time)
//   - invites sent later (/signups resume, /signups invite) include the block
//   - invite DMs already delivered keep their old text
export async function setRoundTracks(params: {
  leagueId: string
  byDiscordId: string
  tracks: string[]
}): Promise<SetTracksResult> {
  const { leagueId, byDiscordId } = params
  const tracks = params.tracks.slice(0, MAX_REQUESTED_TRACKS)

  if (!(await canOpenSignups(byDiscordId, leagueId))) {
    return { ok: false, error: 'Only league owners can change signup tracks.' }
  }
  if (tracks.length === 0) {
    return { ok: false, error: 'Give at least one track.' }
  }

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, message, leagues!inner(name)')
    .eq('league_id', leagueId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!round) {
    return {
      ok: false,
      error: 'No signup round is open for this league. Open one with `/signups open` first.',
    }
  }

  // Keep the owner's own text; swap out only the pictures block.
  const existing = (round.message ?? '').trim()
  const at = existing.indexOf(REQUEST_MARKER)
  const replaced = at !== -1
  const leagueName = (round as any).leagues?.name ?? 'the league'
  const lead =
    (replaced ? existing.slice(0, at) : existing).trim() ||
    defaultInviteContent(leagueName, round.name)

  const { error } = await db()
    .from('signup_rounds')
    .update({ message: `${lead}\n\n${trackRequestBlock(tracks)}` })
    .eq('id', round.id)
  if (error) return { ok: false, error: error.message }

  return { ok: true, roundId: round.id, roundName: round.name, tracks, replaced }
}

// DMs drivers who have ALREADY signed up (any round of the season) asking for
// the pictures. Skips drivers who have already sent some for this season.
// Plain text, no buttons. Running it twice messages people twice.
export async function notifySignedUpForPhotos(params: {
  roundId: string
  tracks: string[]
  budgetMs?: number
}): Promise<{ sent: number; failed: number; skipped: number; remaining: number }> {
  const started = Date.now()
  const budgetMs = params.budgetMs ?? 45_000
  const none = { sent: 0, failed: 0, skipped: 0, remaining: 0 }

  const { data: round } = await db()
    .from('signup_rounds')
    .select('id, name, status, leagues!inner(name)')
    .eq('id', params.roundId)
    .single()
  if (!round || round.status !== 'open') return none

  const roundIds = await seasonRoundIds(round.id)

  const { data: signed } = await db()
    .from('league_signups')
    .select('driver_id, drivers!inner(discord_id)')
    .in('round_id', roundIds)
    .eq('status', 'signed_up')

  const { data: photoRows } = await db()
    .from('signup_photos')
    .select('driver_id')
    .in('round_id', roundIds)
  const alreadySent = new Set(((photoRows ?? []) as any[]).map((p) => p.driver_id as string))

  const seen = new Set<string>()
  const queue: string[] = []
  let skipped = 0
  for (const row of (signed ?? []) as any[]) {
    if (seen.has(row.driver_id)) continue
    seen.add(row.driver_id)
    const d = Array.isArray(row.drivers) ? row.drivers[0] : row.drivers
    const discordId = d?.discord_id as string | undefined
    if (!discordId || alreadySent.has(row.driver_id)) {
      skipped++
      continue
    }
    queue.push(discordId)
  }

  const leagueName = (round as any).leagues?.name ?? 'the league'
  const subject = params.tracks.length === 1 ? 'this track' : 'each of these tracks'
  const content =
    `📸 **${leagueName}: ${round.name}** — one more step\n` +
    `Thanks for signing up. The league now needs a picture of ${subject}. Send them ` +
    `to me right here in this DM with \`/signup photos\` (attach up to ` +
    `${MAX_REQUESTED_TRACKS} images) and I'll post them for the league:\n` +
    params.tracks.map((t, i) => `${i + 1}. ${t}`).join('\n')

  let sent = 0
  let failed = 0
  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - started > budgetMs) {
      return { sent, failed, skipped, remaining: queue.length - i }
    }
    try {
      const channel = await discord('/users/@me/channels', { recipient_id: queue[i] })
      await discord(`/channels/${channel.id}/messages`, {
        content,
        allowed_mentions: { parse: [] },
      })
      sent++
    } catch (e) {
      console.error('[signups] photo request DM failed:', e)
      failed++
    }
    await sleep(SEND_DELAY_MS)
  }

  return { sent, failed, skipped, remaining: 0 }
}
