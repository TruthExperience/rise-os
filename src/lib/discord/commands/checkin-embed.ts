// src/lib/discord/commands/checkin-embed.ts
//
// Shared check-in embed + button builders. Imported by:
//   - commands/checkin.ts            (checkin-create, roundLabel in replies)
//   - components/router.ts           (checkin_btn:<postId>:<status> clicks)
//   - api/pitboss/checkin/reminders  (T-5m race_time_flag re-render)
//
// Everything returned here is a plain JSON object (no discord.js builders)
// so it can go straight into a Discord REST body or an interaction response.

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

// ── Race state ─────────────────────────────────────────────────────

type RaceState = "open" | "formation" | "started";

function raceState(raceTimeMs: number | null, now = Date.now()): RaceState {
  if (raceTimeMs == null) return "open";
  if (now >= raceTimeMs) return "started";
  if (raceTimeMs - now <= 5 * 60 * 1000) return "formation";
  return "open";
}

const STATE_DISPLAY: Record<RaceState, { text: string; color: number }> = {
  open: { text: "🔴 Check-in open", color: 0x5865f2 },
  formation: { text: "🟡 Formation lap — get to the lobby", color: 0xf1c40f },
  started: { text: "🟢 Lights out — race underway", color: 0x2ecc71 },
};

// ── Embed ──────────────────────────────────────────────────────────

function mentionList(ids: string[]): string {
  if (ids.length === 0) return "—";
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

export function buildCheckinEmbed(args: {
  round: CheckinRound;
  divisionCode: string;
  post: CheckinPost;
  grouped: GroupedCheckins;
}): Record<string, unknown> {
  const { round, divisionCode, post, grouped } = args;

  // Override precedence: manual /checkin-create values win over the calendar.
  const track = post.track_override ?? round.circuit ?? round.name;
  const country = post.country_override ?? round.country;
  const flag = resolveFlag(post.flag_override ?? round.flag_emoji, country);

  const raceMs = post.race_time ? Date.parse(post.race_time) : NaN;
  const raceTimeMs = Number.isNaN(raceMs) ? null : raceMs;
  const state = STATE_DISPLAY[raceState(raceTimeMs)];

  const trackLine = [flag.emoji, `**${track}**`, country ? `· ${country}` : null]
    .filter(Boolean)
    .join(" ");

  const fields: Record<string, unknown>[] = [
    {
      name: "🕒 Race time",
      // <t:..:R> counts down client-side, so it stays live between re-renders.
      value:
        raceTimeMs != null
          ? `<t:${Math.floor(raceTimeMs / 1000)}:F>\n<t:${Math.floor(raceTimeMs / 1000)}:R>`
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
      value: mentionList(ids),
      inline: status === "confirmed" || status === "tentative" || status === "declined" ? true : false,
    });
  }

  const embed: Record<string, unknown> = {
    title: `${roundLabel(round)} — Division ${divisionCode}`,
    description: `${trackLine}\n${state.text}`,
    color: state.color,
    fields,
    footer: { text: "Tap a button to respond — tap it again to clear your response." },
  };

  if (flag.code) {
    embed.thumbnail = { url: `https://flagcdn.com/w160/${flag.code}.png` };
  }

  return embed;
}

// ── Buttons ────────────────────────────────────────────────────────

/** custom_id format is parsed by components/router.ts: checkin_btn:<postId>:<status> */
export function buildCheckinComponents(postId: string): Record<string, unknown>[] {
  return [
    {
      type: 1, // action row (max 5 buttons)
      components: CHECKIN_STATUSES.map((status) => ({
        type: 2, // button
        style: STATUS_META[status].style,
        label: STATUS_META[status].label,
        emoji: { name: STATUS_META[status].emoji },
        custom_id: `checkin_btn:${postId}:${status}`,
      })),
    },
  ];
}
