// src/lib/currency.ts
//
// League money display.
//
// Each league prices in its own money, so the sign and the league code in front
// of a figure come from a row per league rather than one global rule. W11
// Racing Series is UK-based, so it writes £W11 (British pound sign plus the
// league code); TRL and WSC stay in dollars with their own code. Money is
// therefore never a bare number that could be mistaken for another league's:
// "£W11 1,000,000", "$TRL 1,000,000".
//
// The stored rise_os.leagues.currency_code is not enough on its own: the admin
// form only accepts a 3-letter code, and some league slugs differ from their
// code (w11-racing-series -> W11), so the code and sign are mapped here and the
// table grows as leagues are added.

type LeagueCurrency = {
  sign: string;
  code: string;
  name: string;
};

// Keyed by league slug. Both the short and long slug are listed where they are
// both in use, so a league can't fall through to the default by accident.
const LEAGUE_CURRENCIES: Record<string, LeagueCurrency> = {
  // W11 Racing Series — UK league, pounds sterling.
  w11: { sign: "£", code: "W11", name: "W11 pounds" },
  "w11-racing-series": { sign: "£", code: "W11", name: "W11 pounds" },
  // Truth Racing League — US dollars.
  trl: { sign: "$", code: "TRL", name: "TRL dollars" },
  // World Series Championship — US dollars.
  wsc: { sign: "$", code: "WSC", name: "WSC dollars" },
};

function currencyFor(slug: string | null | undefined): LeagueCurrency | null {
  const s = (slug ?? "").toLowerCase().trim();
  if (!s) return null;
  return LEAGUE_CURRENCIES[s] ?? null;
}

export function isPoundsLeague(slug: string | null | undefined): boolean {
  return currencyFor(slug)?.sign === "£";
}

/**
 * Fallback code for a league with no table row: short slugs are already
 * abbreviations (aarl -> AARL), hyphenated ones get initialised
 * (halo-racing-league -> HRL).
 */
function derivedCode(slug: string | null | undefined): string {
  const s = (slug ?? "").toLowerCase().trim();
  if (!s) return "";
  if (!s.includes("-")) return s.toUpperCase();
  return s
    .split("-")
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export function leagueCurrencyLabel(slug: string | null | undefined): string {
  const known = currencyFor(slug);
  if (known) return known.name;
  const code = derivedCode(slug);
  return code ? `${code} dollars` : "";
}

/**
 * The prefix a league's money is written with: "£W11", "$TRL", "$WSC".
 * `fallbackPrefix` is used only when the league has no currency row — callers
 * that hold the league row's own currency_code can pass `$${currencyCode}`.
 */
export function leagueCurrencySymbol(
  slug: string | null | undefined,
  fallbackPrefix = "$"
): string {
  const known = currencyFor(slug);
  if (known) return `${known.sign}${known.code}`;
  const code = derivedCode(slug);
  return code ? `${fallbackPrefix}${code}` : fallbackPrefix;
}

/**
 * Formats an amount in the league's own money, always with the league's prefix
 * so the figure identifies itself ($TRL, £W11). `withLabel` appends the long
 * name ("W11 pounds") for the rare place that needs it spelled out.
 */
export function formatLeagueMoney(
  n: number | null | undefined,
  slug: string | null | undefined,
  options: { withLabel?: boolean } = {}
): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const amount = Number(n).toLocaleString("en-US");
  const formatted = `${leagueCurrencySymbol(slug)} ${amount}`;
  if (!options.withLabel) return formatted;
  const label = leagueCurrencyLabel(slug);
  return label ? `${formatted} (${label})` : formatted;
}
