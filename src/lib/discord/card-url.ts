// FILE: src/lib/discord/card-url.ts   (new file)
// Signed URLs for the results/standings card images that the Discord bot
// attaches to its posts (see src/app/api/pitboss/card/route.tsx). The card
// route is public so Discord can fetch it, so each URL carries an HMAC
// signature; without it the route refuses to render. The signature covers the
// league, kind, season and round only, so the `v` cache-buster can change on
// every edit without invalidating it.
import { createHmac, timingSafeEqual } from "crypto";

export type CardKind =
  | "race"
  | "sprint"
  | "quali"
  | "drivers"
  | "teams"
  | "stats"
  | "stats2"
  | "checkin";
export interface CardParams {
  kind: CardKind;
  league_id: string;
  season: string;
  round?: number | string | null;
  /**
   * Division label for kind "checkin" (e.g. F2_24): the team logo strip is
   * per division, not per season. Appended to the signed payload only when
   * set, so every card URL signed before this existed still verifies.
   */
  division?: string | null;
}

function secret(): string {
  return process.env.PITBOSS_INTERNAL_KEY || process.env.CRON_SECRET || "";
}

function payload(p: CardParams): string {
  const base = [p.kind, p.league_id, p.season, p.round ?? ""].join("|");
  // Appended, never inserted: cards without a division keep the exact payload
  // they were signed with.
  return p.division ? `${base}|${p.division}` : base;
}

export function signCard(p: CardParams): string {
  return createHmac("sha256", secret()).update(payload(p)).digest("hex");
}

export function verifyCard(p: CardParams, sig: string | null): boolean {
  if (!sig || !secret()) return false;
  const expected = Buffer.from(signCard(p), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Returns null when the app URL or signing secret isn't configured, so the
// caller can fall back to the plain text table.
export function buildCardUrl(p: CardParams): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base || !secret()) return null;
  const q = new URLSearchParams({
    kind: p.kind,
    league_id: p.league_id,
    season: p.season,
    ...(p.round != null && p.round !== "" ? { round: String(p.round) } : {}),
    ...(p.division ? { division: p.division } : {}),
    sig: signCard(p),
    v: String(Date.now()),
  });
  return `${base}/api/pitboss/card?${q.toString()}`;
}
