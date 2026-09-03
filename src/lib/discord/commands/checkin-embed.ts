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
    ? `📍 **Track:** ${round.circuit}${round.country ? ` (${round.country})` : ""}`
    : "📍 **Track:** TBD";
  const pingLine = `📨 **Ping Delivery:** ${post.ping_delivery ?? "Channel only"}`;
  const weatherLine = `☁️ **Weather:** ${post.weather_text ?? "Not set"}`;

  const descriptionParts = [trackLine, "—————", pingLine, "—————", weatherLine];

  if (post.race_time) {
    const unix = Math.floor(new Date(post.race_time).getTime() / 1000);
    descriptionParts.push(
      "—————",
      `⏰ **Start:** <t:${unix}:F>  (<t:${unix}:R>)`
    );
  }

  const fields = CHECKIN_STATUSES.map((status) => {
    const meta = STATUS_META[status];
    const ids = grouped[status] ?? [];
    return {
      name: `${meta.emoji} ${meta.label} (${ids.length})`,
      value: ids.length > 0 ? ids.map((id) => `<@${id}>`).join("\n") : "none",
      inline: false,
    };
  });

  return {
    title: `${round.flag_emoji ?? "🏁"} ${roundLabel(round)} — Division ${divisionCode}`,
    description: descriptionParts.join("\n"),
    fields,
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
