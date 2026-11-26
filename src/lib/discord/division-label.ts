// src/lib/discord/division-label.ts
//
// One definition of "this team is in that division".
//
// Two places scope teams by division and they read from different queries: the
// check-in embed only needs names, and the logo strip on the card route needs
// full franchise rows. They have to agree — a card listing a team under
// "Confirmed" while the strip beside it shows a different division's grid is
// worse than no scoping at all — so both go through here.

/** "F2_24", "f2 24" and "F2-24" all normalise to "f2 24". */
function normDivision(label: string | null | undefined): string {
  return (label ?? "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
}

/** True only when both sides are non-empty and normalise to the same label. */
function sameDivision(
  rowDivision: string | null | undefined,
  code: string | null | undefined
): boolean {
  const a = normDivision(rowDivision);
  return a !== "" && a === normDivision(code);
}

/**
 * Rows belonging to the given division. When the code matches nothing — a
 * league that leaves franchises.division null, or names its tiers differently
 * from its franchises (VRC's "T1 26" does not appear on any franchise) — every
 * row comes back, which is what callers did before division scoping existed.
 */
export function scopeToDivision<T>(
  rows: readonly T[],
  divisionCode: string | null | undefined,
  divisionOf: (row: T) => string | null | undefined
): T[] {
  const matched = rows.filter((row) => sameDivision(divisionOf(row), divisionCode));
  return matched.length > 0 ? matched : [...rows];
}
