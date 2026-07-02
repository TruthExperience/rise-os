export type CfbTeam = {
  id: string;
  team_name: string;
  nickname: string | null;
  conference: string | null;
  ovr: number | null;
  offense_ovr: number | null;
  defense_ovr: number | null;
  logo_url: string | null;
};

export function normalizeTeamName(name: string) {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokens that are genuinely interchangeable abbreviations of the SAME word.
// Do NOT add "college" / "university" / "state" here on their own —
// those words distinguish real, different schools (e.g. "Texas" vs
// "Texas College" vs "Texas State" are three different institutions).
const TOKEN_ALIASES: Record<string, string> = {
  st: "state",
  univ: "university",
};

function canonicalToken(tok: string) {
  return TOKEN_ALIASES[tok] ?? tok;
}

function tokenize(name: string): string[] {
  return normalizeTeamName(name)
    .split(" ")
    .filter(Boolean)
    .map(canonicalToken);
}

function sameTokenSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((tok, i) => tok === sb[i]);
}

// Explicit aliases for franchise names that don't literally match a
// cfb_teams.team_name, even after tokenization. Unlike the old substring
// fallback, this is a closed, human-reviewed list — no accidental
// cross-matches to a different school. Add entries here as you notice
// more franchises with abbreviated/nickname display names. Keys must be
// the normalized (lowercase, punctuation-stripped) franchise name.
const FRANCHISE_NAME_ALIASES: Record<string, string> = {
  "ndsu": "north dakota state",
  "cal": "california",
  "ole miss": "mississippi",
  "pitt": "pittsburgh",
  "unc": "north carolina",
  "usc": "southern california",
  "lsu": "louisiana state",
  "smu": "southern methodist",
  "tcu": "texas christian",
  "utep": "texas el paso",
  "utsa": "texas san antonio",
  "unlv": "nevada las vegas",
  "uconn": "connecticut",
  "umass": "massachusetts",
  "byu": "brigham young",
};

/**
 * Matches a franchise's display name to a row in rise_os.cfb_teams.
 *
 * This only accepts a match when the full, canonicalized token set of the
 * franchise name (or its explicit alias) is EQUAL to the token set of the
 * team_name (or nickname) — order-independent, but no substring/containment
 * matching.
 *
 * Containment matching was removed on purpose: it silently matched schools
 * with genuinely different identities that happen to share a leading word
 * ("Alabama" matching "Alabama A&M" / "Alabama State", "Virginia" matching
 * "Virginia Union" / "Virginia State" / "Virginia University of Lynchburg",
 * "Texas" matching "Texas College" / "Texas Southern" / "Texas A&M", etc.)
 * and handed those franchises a borrowed OVR that wasn't theirs.
 *
 * A franchise with no real CFB27 counterpart (and no listed alias) should
 * show no OVR rather than inherit a different school's rating.
 */
export function findCfbTeam(franchiseName: string, cfbTeams: CfbTeam[]): CfbTeam | null {
  if (!franchiseName || !cfbTeams?.length) return null;

  const normalized = normalizeTeamName(franchiseName);
  const aliasTarget = FRANCHISE_NAME_ALIASES[normalized];
  const targetTokens = tokenize(aliasTarget ?? franchiseName);
  if (targetTokens.length === 0) return null;

  // 1. Exact token-set match on team_name (handles "Ohio St" == "Ohio State"
  //    via the st/state alias, plus any explicit franchise-name alias above)
  let match = cfbTeams.find((t) => sameTokenSet(tokenize(t.team_name), targetTokens));
  if (match) return match;

  // 2. Exact token-set match on nickname (e.g. a franchise literally named
  //    "Crimson Tide")
  match = cfbTeams.find(
    (t) => !!t.nickname && sameTokenSet(tokenize(t.nickname), targetTokens)
  );
  return match ?? null;
}
