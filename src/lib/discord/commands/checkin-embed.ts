// src/lib/discord/commands/checkin-embed.ts
//
// Shared check-in embed + button builders. Imported by:
//   - commands/checkin.ts            (checkin-create, roundLabel in replies)
//   - components/router.ts           (checkin_btn:<postId>:<status> clicks)
//   - api/pitboss/checkin/reminders  (T-5m race_time_flag re-render)
//
// Everything returned here is a plain JSON object (no discord.js builders)
// so it can go straight into a Discord REST body or an interaction response.

import { createAdminClient } from "@/lib/supabase/server";

export const CHECKIN_STATUSES = [
  "confirmed",
  "tentative",
  "declined",
  "healer",
  "damage",
] as const;

export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];

// Minimal shapes. Callers pass wider rows (extra columns are fine).
export interface CheckinRound {
  name: string;
  round_number: number | null;
  circuit: string | null;
  country: string | null;
  flag_emoji: string | null;
}

export interface CheckinPost {
  weather_text: string | null;
  ping_delivery: string | null;
  race_time: string | null;
  track_override?: string | null;
  country_override?: string | null;
  flag_override?: string | null;
}

export type GroupedCheckins = Partial<Record<CheckinStatus, string[]>>;

/** discord_id -> team name; the embed groups mentions under each team. */
export type TeamLabels = Record<string, string>;

/**
 * Team name for each given Discord user, from their active
 * franchise_rosters row in this league (the same source grid generation
 * and reminders use). Drivers with no active roster row are left out.
 * Never throws: a failed lookup just means the embed shows no team names.
 *
 * franchise_rosters (pitboss) and franchises (rise_os) are queried
 * separately — embedded cross-schema selects don't resolve (see the
 * PATCH note in checkin.ts).
 */
export async function fetchTeamLabels(
  leagueId: string,
  discordIds: string[]
): Promise<TeamLabels> {
  const out: TeamLabels = {};
  try {
    const ids = [...new Set(discordIds)];
    if (ids.length === 0) return out;
    const supabase = createAdminClient();

    const { data: drivers } = await supabase
      .schema("pitboss")
      .from("drivers")
      .select("id, discord_id")
      .in("discord_id", ids);
    const discordByDriver = new Map(
      (drivers ?? []).map((d: any) => [d.id as string, d.discord_id as string])
    );
    if (discordByDriver.size === 0) return out;

    const { data: rosters } = await supabase
      .schema("pitboss")
      .from("franchise_rosters")
      .select("driver_id, franchise_id, created_at")
      .eq("league_id", leagueId)
      .is("released_at", null)
      .in("driver_id", [...discordByDriver.keys()])
      .order("created_at", { ascending: false });
    if (!rosters || rosters.length === 0) return out;

    const franchiseIds = [...new Set(rosters.map((r: any) => r.franchise_id as string))];
    const { data: franchises } = await supabase
      .schema("rise_os")
      .from("franchises")
      .select("id, name")
      .in("id", franchiseIds);
    const nameById = new Map((franchises ?? []).map((f: any) => [f.id as string, f.name as string]));

    // Newest roster row wins if a driver somehow has more than one.
    for (const r of rosters as any[]) {
      const discordId = discordByDriver.get(r.driver_id);
      const name = nameById.get(r.franchise_id);
      if (discordId && name && !out[discordId]) out[discordId] = name;
    }
  } catch (err) {
    console.error("[checkin] team label lookup failed:", err);
  }
  return out;
}

/**
 * Every team (franchise) in the league, A-Z, so the Confirmed list can show
 * teams that have no driver checked in yet. Never throws: on failure the
 * embed just lists the teams that do have drivers.
 */
export async function fetchLeagueTeamNames(leagueId: string): Promise<string[]> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .schema("rise_os")
      .from("franchises")
      .select("name")
      .eq("league_id", leagueId);
    const names = ((data ?? []) as { name: string | null }[])
      .map((f) => f.name)
      .filter((n): n is string => !!n);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error("[checkin] league team lookup failed:", err);
    return [];
  }
}

/** Every Discord id in a grouped check-in, for fetchTeamLabels. */
export function groupedDiscordIds(grouped: GroupedCheckins): string[] {
  return CHECKIN_STATUSES.flatMap((s) => grouped[s] ?? []);
}

const STATUS_META: Record<
  CheckinStatus,
  { label: string; emoji: string; style: 1 | 2 | 3 | 4 }
> = {
  confirmed: { label: "Confirmed", emoji: "✅", style: 3 }, // success
  tentative: { label: "Tentative", emoji: "❔", style: 1 }, // primary
  declined: { label: "Declined", emoji: "❌", style: 4 }, // danger
  healer: { label: "Healer", emoji: "🩹", style: 2 }, // secondary
  damage: { label: "Damage", emoji: "💥", style: 2 }, // secondary
};

/** "Round 5 — Japanese Grand Prix" (falls back to just the name). */
export function roundLabel(round: Pick<CheckinRound, "name" | "round_number">): string {
  return round.round_number != null
    ? `Round ${round.round_number} — ${round.name}`
    : round.name;
}

// ── Flags ──────────────────────────────────────────────────────────

const COUNTRY_TO_CODE: Record<string, string> = {
  australia: "au", austria: "at", azerbaijan: "az", bahrain: "bh",
  belgium: "be", brazil: "br", canada: "ca", china: "cn", france: "fr",
  germany: "de", hungary: "hu", italy: "it", japan: "jp", mexico: "mx",
  monaco: "mc", netherlands: "nl", portugal: "pt", qatar: "qa",
  "saudi arabia": "sa", singapore: "sg", spain: "es", turkey: "tr",
  uae: "ae", "united arab emirates": "ae", uk: "gb",
  "united kingdom": "gb", "great britain": "gb", usa: "us",
  "united states": "us", "united states of america": "us",
};

function codeToFlagEmoji(code: string): string {
  return [...code.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

/** 🇯🇵 -> "jp" (null if the string isn't a regional-indicator pair). */
function flagEmojiToCode(emoji: string | null | undefined): string | null {
  if (!emoji) return null;
  const pts = [...emoji.trim()].map((c) => c.codePointAt(0)!);
  if (
    pts.length === 2 &&
    pts.every((p) => p >= 0x1f1e6 && p <= 0x1f1ff)
  ) {
    return pts.map((p) => String.fromCharCode(p - 0x1f1e6 + 97)).join("");
  }
  return null;
}

function resolveFlag(
  flagEmoji: string | null,
  country: string | null
): { emoji: string | null; code: string | null } {
  const code =
    flagEmojiToCode(flagEmoji) ??
    (country ? COUNTRY_TO_CODE[country.trim().toLowerCase()] ?? null : null);
  return { emoji: code ? codeToFlagEmoji(code) : null, code };
}

// ── Race state / five lights ───────────────────────────────────────

const MIN = 60 * 1000;

/** Check-in locks this long before race_time (buttons + /checkin). */
export const CHECKIN_LOCKOUT_MS = 15 * MIN;

/**
 * One light per milestone, same schedule as the automated pings:
 *   T-3h · T-1h · T-30m · T-15m (lockout) · T-5m (formation)
 * All five lit = formation lap. At race_time they go green: lights out.
 */
const LIGHT_MILESTONES_MS = [180 * MIN, 60 * MIN, 30 * MIN, 15 * MIN, 5 * MIN];
const LIGHTS_TOTAL = LIGHT_MILESTONES_MS.length;

type RaceState = "open" | "locked" | "formation" | "started";

/** True from 15 minutes before race_time onward. No race_time = never locked. */
export function isCheckinLocked(
  raceTime: string | null | undefined,
  now = Date.now()
): boolean {
  if (!raceTime) return false;
  const ms = Date.parse(raceTime);
  if (Number.isNaN(ms)) return false;
  return ms - now <= CHECKIN_LOCKOUT_MS;
}

function raceState(
  raceTimeMs: number | null,
  now = Date.now()
): { state: RaceState; lit: number } {
  if (raceTimeMs == null) return { state: "open", lit: 0 };
  const remaining = raceTimeMs - now;
  if (remaining <= 0) return { state: "started", lit: LIGHTS_TOTAL };
  const lit = LIGHT_MILESTONES_MS.filter((m) => remaining <= m).length;
  if (remaining <= 5 * MIN) return { state: "formation", lit };
  if (remaining <= CHECKIN_LOCKOUT_MS) return { state: "locked", lit };
  return { state: "open", lit };
}

function lightsRow(state: RaceState, lit: number): string {
  if (state === "started") return "🟢".repeat(LIGHTS_TOTAL);
  return "🔴".repeat(lit) + "⚫".repeat(LIGHTS_TOTAL - lit);
}

const STATE_DISPLAY: Record<RaceState, { text: string; color: number }> = {
  open: { text: "Check-in open", color: 0x5865f2 },
  locked: { text: "🔒 Check-in locked — race starts soon", color: 0xe67e22 },
  formation: { text: "🔒 Formation lap — get to the lobby", color: 0xf1c40f },
  started: { text: "🏁 GREEN FLAG — lights out, race underway", color: 0x2ecc71 },
};

// ── Embed ──────────────────────────────────────────────────────────

function mentionList(ids: string[], teams?: TeamLabels, allTeams?: string[]): string {
  const withTeams =
    (!!teams && Object.keys(teams).length > 0) || (!!allTeams && allTeams.length > 0);
  if (ids.length === 0 && !(withTeams && allTeams && allTeams.length > 0)) return "—";

  // No team data: compact mention list, as before.
  if (!withTeams) {
    const out: string[] = [];
    let len = 0;
    for (let i = 0; i < ids.length; i++) {
      const m = `<@${ids[i]}>`;
      // Discord field values cap at 1024 chars; leave room for "+N more".
      if (len + m.length + 1 > 980) {
        out.push(`+${ids.length - i} more`);
        break;
      }
      out.push(m);
      len += m.length + 1;
    }
    return out.join(" ");
  }

  // Team-first: one line per team, "**Team** · @driver @driver".
  // Teams are ordered A-Z; drivers without a team go last.
  const byTeam = new Map<string, string[]>();
  const noTeam: string[] = [];
  // Every team gets a line, even with nobody in it (shown as "—").
  for (const t of allTeams ?? []) byTeam.set(t, []);
  for (const id of ids) {
    const team = teams?.[id];
    if (!team) {
      noTeam.push(id);
      continue;
    }
    const list = byTeam.get(team);
    if (list) list.push(id);
    else byTeam.set(team, [id]);
  }

  const groups: { label: string; ids: string[] }[] = [
    ...[...byTeam.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, members]) => ({ label, ids: members })),
    ...(noTeam.length > 0 ? [{ label: "No team", ids: noTeam }] : []),
  ];

  const lines: string[] = [];
  let len = 0;
  let shown = 0;
  for (const g of groups) {
    const line = `**${g.label}** · ${g.ids.length > 0 ? g.ids.map((id) => `<@${id}>`).join(" ") : "—"}`;
    // Discord field values cap at 1024 chars; leave room for "+N more".
    if (len + line.length + 1 > 980) {
      lines.push(`+${ids.length - shown} more`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
    shown += g.ids.length;
  }
  return lines.join("\n");
}

export function buildCheckinEmbed(args: {
  round: CheckinRound;
  divisionCode: string;
  post: CheckinPost;
  grouped: GroupedCheckins;
  /** Optional team names (see fetchTeamLabels). */
  teams?: TeamLabels;
  /** Every team in the league (see fetchLeagueTeamNames); all shown under Confirmed. */
  allTeams?: string[];
}): Record<string, unknown> {
  const { round, divisionCode, post, grouped, teams, allTeams } = args;
  const showTeams =
    (!!teams && Object.keys(teams).length > 0) || (!!allTeams && allTeams.length > 0);

  // Override precedence: manual /checkin-create values win over the calendar.
  const track = post.track_override ?? round.circuit ?? round.name;
  const country = post.country_override ?? round.country;
  const flag = resolveFlag(post.flag_override ?? round.flag_emoji, country);

  const raceMs = post.race_time ? Date.parse(post.race_time) : NaN;
  const raceTimeMs = Number.isNaN(raceMs) ? null : raceMs;
  const { state: raceStateName, lit } = raceState(raceTimeMs);
  const state = STATE_DISPLAY[raceStateName];
  const locked = raceStateName !== "open";

  const trackLine = [flag.emoji, `**${track}**`, country ? `· ${country}` : null]
    .filter(Boolean)
    .join(" ");

  const fields: Record<string, unknown>[] = [
    {
      name: "🕒 Race time",
      // <t:..:R> counts down client-side, so it stays live between re-renders.
      // The lockout line flips to "locked" on the T-15m re-render.
      value:
        raceTimeMs != null
          ? `<t:${Math.floor(raceTimeMs / 1000)}:F>\n<t:${Math.floor(raceTimeMs / 1000)}:R>\n` +
            (locked
              ? "🔒 Check-in locked"
              : `⏳ Check-in closes <t:${Math.floor((raceTimeMs - CHECKIN_LOCKOUT_MS) / 1000)}:R>`)
          : "TBC",
      inline: true,
    },
    { name: "🌦️ Weather", value: post.weather_text || "TBC", inline: true },
    { name: "📣 Pings", value: post.ping_delivery || "Channel only", inline: true },
  ];

  for (const status of CHECKIN_STATUSES) {
    const ids = grouped[status] ?? [];
    const meta = STATUS_META[status];
    fields.push({
      name: `${meta.emoji} ${meta.label} (${ids.length})`,
      value: mentionList(ids, teams, status === "confirmed" ? allTeams : undefined),
      // Team names make entries wide, so stack the columns when shown.
      inline:
        !showTeams && (status === "confirmed" || status === "tentative" || status === "declined"),
    });
  }

  const embed: Record<string, unknown> = {
    title: `${roundLabel(round)} — Division ${divisionCode}`,
    description: `${trackLine}\n${lightsRow(raceStateName, lit)} ${state.text}`,
    color: state.color,
    fields,
    footer: {
      text: locked
        ? "Check-in is locked — ask a steward if you need a change."
        : "Tap a button to respond — tap it again to clear your response. Locks 15 min before the race.",
    },
  };

  if (flag.code) {
    embed.thumbnail = { url: `https://flagcdn.com/w160/${flag.code}.png` };
  }

  return embed;
}

// ── Buttons ────────────────────────────────────────────────────────

/** custom_id format is parsed by components/router.ts: checkin_btn:<postId>:<status> */
export function buildCheckinComponents(
  postId: string,
  /** Pass the post's race_time so the buttons grey out once check-in locks. */
  raceTime?: string | null
): Record<string, unknown>[] {
  const disabled = isCheckinLocked(raceTime);
  return [
    {
      type: 1, // action row (max 5 buttons)
      components: CHECKIN_STATUSES.map((status) => ({
        type: 2, // button
        style: STATUS_META[status].style,
        label: STATUS_META[status].label,
        emoji: { name: STATUS_META[status].emoji },
        custom_id: `checkin_btn:${postId}:${status}`,
        ...(disabled ? { disabled: true } : {}),
      })),
    },
  ];
}
