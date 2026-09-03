// Builds the Discord embed + button row for a round check-in post.
// Shared between checkin-create (initial post) and the button click
// handler (re-render after every response) so the two never drift.

export type CheckinStatus =
  | "confirmed"
  | "tentative"
  | "declined"
  | "healer"
  | "damage";

export const CHECKIN_STATUSES: CheckinStatus[] = [
  "confirmed",
  "tentative",
  "declined",
  "healer",
  "damage",
];

const STATUS_META: Record<
  CheckinStatus,
  { label: string; emoji: string; buttonStyle: number }
> = {
  confirmed: { label: "Accepted", emoji: "✅", buttonStyle: 3 }, // SUCCESS
  declined: { label: "Declined", emoji: "❌", buttonStyle: 4 }, // DANGER
  tentative: { label: "Tentative", emoji: "❓", buttonStyle: 1 }, // PRIMARY
  healer: { label: "Healer", emoji: "➕", buttonStyle: 2 }, // SECONDARY
  damage: { label: "Damage", emoji: "🗡️", buttonStyle: 2 }, // SECONDARY
};

// What each button means for this league. Shown as a legend field so
// drivers know what to press without asking in chat.
const STATUS_MEANINGS: Record<CheckinStatus, string> = {
  confirmed: "D1 tick only",
  declined: "Unavailable for both Divisions to tick",
  tentative:
    "not sure but must be changed on the day — if not, you will not be racing (D1 tick only)",
  healer: "for D2 drivers, D1 reserves, and Team Principals to tick",
  damage: "only Commentator to tick",
};

export interface CheckinRoundInfo {
  name: string | null;
  round_number: number | null;
  circuit: string | null;
  country: string | null;
  flag_emoji: string | null;
}

export interface CheckinPostInfo {
  id: string;
  weather_text: string | null;
  ping_delivery: string | null;
  race_time: string | null; // ISO timestamp
}

export function roundLabel(round: {
  name: string | null;
  round_number: number | null;
}) {
  return (
    round.name ?? (round.round_number != null ? `Round ${round.round_number}` : "this round")
  );
}

/**
 * Race-director style "lights" line, computed fresh every time the
 * embed is built (on initial post and on every button re-render — same
 * pattern as the <t:...:R> countdown, which Discord updates live on its
 * own but whose *bucket* — grid forming vs. lights out — only changes
 * when we re-render). Thresholds roughly mirror an F1 broadcast:
 * pit lane opens -> grid forms -> formation lap -> lights out.
 */
function raceLights(raceTimeIso: string | null): string {
  if (!raceTimeIso) return "";
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  const minsRemaining = msRemaining / 60000;

  if (minsRemaining <= 0) return "🟢🟢🟢🟢🟢  **LIGHTS OUT — GO!**";
  if (minsRemaining <= 5) return "🔴🔴🔴🔴🔴  **Formation lap — get ready**";
  if (minsRemaining <= 30) return "🔴🔴🔴⚫⚫  **Grid forming**";
  if (minsRemaining <= 60) return "🔴🔴⚫⚫⚫  **Pit lane opens soon**";
  return "🔴⚫⚫⚫⚫  **Session upcoming**";
}

/**
 * Digital HH:MM:SS countdown, computed fresh at render time (same
 * "computed on build, not live" caveat as raceLights — this freezes
 * until the embed is next rebuilt, either by a button click or,
 * once wired up, the checkin-countdown cron).
 */
function formatDigitalCountdown(raceTimeIso: string | null): string | null {
  if (!raceTimeIso) return null;
  const msRemaining = new Date(raceTimeIso).getTime() - Date.now();
  if (msRemaining <= 0) return null; // raceLights already shows LIGHTS OUT

  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return `⏱️ **${pad(hours)}:${pad(minutes)}:${pad(seconds)}**`;
}

/**
 * Flag emojis are built from two Unicode "regional indicator" code
 * points, one per ISO 3166-1 alpha-2 letter (🇨🇳 = 🇨 + 🇳 = "cn").
 * This decodes flag_emoji back into that 2-letter code so we can pull
 * a real flag image from a CDN without storing a separate image URL.
 */
function flagEmojiToCountryCode(flagEmoji: string | null): string | null {
  if (!flagEmoji) return null;
  const codePoints = Array.from(flagEmoji).map((char) => char.codePointAt(0) ?? 0);
  if (codePoints.length !== 2) return null;

  const REGIONAL_INDICATOR_BASE = 0x1f1e6; // 🇦
  const letters = codePoints.map((cp) => cp - REGIONAL_INDICATOR_BASE);
  if (letters.some((n) => n < 0 || n > 25)) return null;

  return letters.map((n) => String.fromCharCode(97 + n)).join(""); // e.g. "cn"
}

function flagImageUrl(flagEmoji: string | null): string | undefined {
  const code = flagEmojiToCountryCode(flagEmoji);
  return code ? `https://flagcdn.com/w320/${code}.png` : undefined;
}

/**
 * grouped[status] = array of discord user IDs who responded with that
 * status. Missing/empty arrays render as "none".
 */
export function buildCheckinEmbed(params: {
  round: CheckinRoundInfo;
  divisionCode: string;
  post: CheckinPostInfo;
  grouped: Partial<Record<CheckinStatus, string[]>>;
}): Record<string, unknown> {
  const { round, divisionCode, post, grouped } = params;

  const trackLine = round.circuit
    ? `📍 **Track:** ${round.flag_emoji ?? ""} ${round.circuit}${round.country ? ` (${round.country})` : ""}`.trim()
    : `📍 **Track:** ${round.flag_emoji ?? ""} TBD`.trim();
  const pingLine = `📨 **Ping Delivery:** ${post.ping_delivery ?? "Channel only"}`;
  const weatherLine = `☁️ **Weather:** ${post.weather_text ?? "Not set"}`;

  const descriptionParts = [trackLine, "—————", pingLine, "—————", weatherLine];

  if (post.race_time) {
    const unix = Math.floor(new Date(post.race_time).getTime() / 1000);
    descriptionParts.push(
      "—————",
      `⏰ **Start:** <t:${unix}:F>  (<t:${unix}:R>)`,
      raceLights(post.race_time)
    );
    const digital = formatDigitalCountdown(post.race_time);
    if (digital) descriptionParts.push(digital);
  }

  const legendField = {
    name: "How to Respond",
    value: CHECKIN_STATUSES.map(
      (status) => `${STATUS_META[status].emoji} **${STATUS_META[status].label}** = ${STATUS_MEANINGS[status]}`
    ).join("\n"),
    inline: false,
  };

  const statusFields = CHECKIN_STATUSES.map((status) => {
    const meta = STATUS_META[status];
    const ids = grouped[status] ?? [];
    return {
      name: `${meta.emoji} ${meta.label} (${ids.length})`,
      value: ids.length > 0 ? ids.map((id) => `<@${id}>`).join("\n") : "none",
      inline: false,
    };
  });

  const flagUrl = flagImageUrl(round.flag_emoji);

  return {
    title: `${round.flag_emoji ?? "🏁"} ${roundLabel(round)} — Division ${divisionCode}`,
    description: descriptionParts.join("\n"),
    fields: [legendField, ...statusFields],
    image: flagUrl ? { url: flagUrl } : undefined,
    color: 0xe10600,
  };
}

export function buildCheckinComponents(postId: string): Record<string, unknown>[] {
  return [
    {
      type: 1, // ACTION_ROW
      components: CHECKIN_STATUSES.map((status) => ({
        type: 2, // BUTTON
        style: STATUS_META[status].buttonStyle,
        label: STATUS_META[status].label,
        emoji: { name: STATUS_META[status].emoji },
        custom_id: `checkin_btn:${postId}:${status}`,
      })),
    },
  ];
}
