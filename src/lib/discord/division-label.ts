// src/lib/discord/division-label.ts
//
// One definition of "this team is in that division".
//
// Two places scope teams by division and they read from different queries: the
// check-in embed only needs names, and the logo strip on the card route needs
// full franchise rows. They have to agree — a card listing a team under
// "Confirmed" while the strip beside it shows a different division's grid is
// worse than no scoping at all — so both go through here.
//
// The two sides are written in different vocabularies. A league's franchises
// carry the base group they race in ("F1", "F1_25", "F2_24"), while
// league_divisions adds the tier a driver sits in and names the same group
// "T1 F1 26" / "T2 F1 26" (roster_division = 'F1'). Comparing the strings
// verbatim therefore matched nothing, and every caller fell back to the whole
// league. So a label is read as three parts — tier token(s) ("t1"), a base
// group ("f1"), and a two- or four-digit season year ("26") — and two labels
// name the same division when the base groups agree, the tiers agree whenever
// both sides state one, and the years agree.
//
// TRL writes its current-season group as plain "F1" while its tier divisions
// say "T1 F1 26", and keeps older groups as "F1_25" / "F2_24". A label with no
// year is therefore read as the season the caller passes as `seasonYear`:
// "T1 F1 26" scopes to the "F1" teams, while "T1 F1 25" scopes only to "F1_25"
// and never picks up the current-season teams (or vice versa).
//
// That season is a parameter, not a clock read. Reading the calendar year here
// meant TRL's season-1 divisions — which keep "26" in their code — would stop
// matching the plain "F1" franchises on 1 January 2027, quietly dropping every
// check-in card back to the whole league. Callers resolve the year from
// rise_os.seasons instead (see season-year.ts), so the match follows the
// season the round actually belongs to.
//
// When a caller has no season to offer, a label without a year cannot be
// placed: it matches nothing, and the caller's whole-league fallback applies
// exactly as it did before division scoping existed. Nothing here guesses a
// year.

const TIER_TOKEN = /^t\d+$/;

/** "26" and 2026 both mean the 2026 season; anything else is not a year. */
export function seasonYearToken(
  value: string | number | null | undefined
): string | null {
  const raw = String(value ?? "").trim();
  if (!/^(?:\d{2}|\d{4})$/.test(raw)) return null;
  return raw.length === 4 ? raw.slice(2) : raw;
}

/** "F2_24", "f2 24" and "F2-24" all normalise to "f2 24". */
function normDivision(label: string | null | undefined): string {
  return (label ?? "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
}

type DivisionKey = {
  /** Tier tokens in the label, e.g. ["t1"]. Empty when the side has none. */
  tiers: string[];
  /** Everything that is not a tier or the trailing year, e.g. "f1". */
  base: string;
  /** Trailing year normalised to two digits ("2026" -> "26"), or null. */
  year: string | null;
};

function keyOf(label: string | null | undefined): DivisionKey {
  const tokens = normDivision(label).split(" ").filter(Boolean);
  const tiers = tokens.filter((t) => TIER_TOKEN.test(t)).sort();
  const rest = tokens.filter((t) => !TIER_TOKEN.test(t));

  let year: string | null = null;
  const last = rest[rest.length - 1];
  if (last !== undefined && seasonYearToken(last) !== null) {
    year = seasonYearToken(last);
    rest.pop();
  }

  return { tiers, base: rest.join(" "), year };
}

/**
 * True only when both sides name the same division. `seasonYear` is the season
 * a year-less label belongs to ("26", or 2026); see the notes above.
 */
function sameDivision(
  rowDivision: string | null | undefined,
  code: string | null | undefined,
  seasonYear: string | number | null | undefined
): boolean {
  const a = keyOf(rowDivision);
  const b = keyOf(code);

  // An empty side (no division set on the row, or no code passed) matches
  // nothing — that is what keeps callers on their whole-league fallback.
  if ((a.base === "" && a.tiers.length === 0) || (b.base === "" && b.tiers.length === 0)) {
    return false;
  }
  if (a.base !== b.base) return false;

  // Both sides naming a tier means it has to be the same tier: T1 and T2 of one
  // group are different divisions, they just share the same teams.
  if (a.tiers.length > 0 && b.tiers.length > 0 && a.tiers.join(" ") !== b.tiers.join(" ")) {
    return false;
  }

  // Both sides state a year -> that is the whole answer.
  if (a.year !== null && b.year !== null) return a.year === b.year;

  // Only one side states a year, so the other one means the caller's season.
  const season = seasonYearToken(seasonYear);
  if (season === null) return false;
  return (a.year ?? season) === (b.year ?? season);
}

/**
 * Rows belonging to the given division. When the code matches nothing — a
 * league that leaves franchises.division null, names its tiers differently
 * from its franchises (VRC's "T1 26" does not appear on any franchise), or
 * arrives without a season to place its year-less labels in — every row comes
 * back, which is what callers did before division scoping existed.
 */
export function scopeToDivision<T>(
  rows: readonly T[],
  divisionCode: string | null | undefined,
  divisionOf: (row: T) => string | null | undefined,
  seasonYear: string | number | null | undefined
): T[] {
  const matched = rows.filter((row) =>
    sameDivision(divisionOf(row), divisionCode, seasonYear)
  );
  return matched.length > 0 ? matched : [...rows];
}
