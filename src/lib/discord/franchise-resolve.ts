// src/lib/discord/franchise-resolve.ts
//
// One franchise lookup for every command that takes a franchise by name.
//
// F2 grids reuse the same team names AND abbreviations in every division, so a
// name on its own cannot identify a row ("AIX Racing" exists in F2_24, F2_25
// and F2_26). The old ILIKE-then-refuse lookup made those teams impossible to
// name at all: every input either matched one of them by accident or was
// rejected as ambiguous.
//
// Each franchise is matched on four aliases, all reduced to lowercase letters
// and digits so spacing and punctuation don't matter ("F2 25", "f2-25" and
// "F2_25" all become "f225"):
//
//   1. its name                     "aixracing"
//   2. its abbreviation             "aix"
//   3. its name + its division      "aixracingf225"
//   4. its abbreviation + division  "aixf225"
//
// So "AIX Racing F2_25" resolves to exactly one franchise, while "AIX Racing"
// still reports the ambiguity — naming the divisions and showing an input that
// does resolve.
import { createAdminClient } from "@/lib/supabase/server";

export type FranchiseRow = {
  id: string;
  name: string;
  abbreviation: string | null;
  division: string | null;
};

export type FranchiseLookup = { franchise: FranchiseRow } | { error: string };

/** Letters and digits only: "F2 25", "f2-25" and "F2_25" all become "f225". */
export function squashFranchise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function resolveFranchiseForLeague(
  leagueId: string,
  input: string
): Promise<FranchiseLookup> {
  const wanted = squashFranchise(input);
  if (!wanted) return { error: "Name a franchise." };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division")
    .eq("league_id", leagueId);

  if (error) {
    console.error("[franchise] lookup failed:", error);
    return { error: `Couldn't look up that franchise: ${error.message}` };
  }

  const rows = (data ?? []) as FranchiseRow[];
  const notFound: FranchiseLookup = {
    error: `No franchise matching "${input}" found in this league.`,
  };
  if (rows.length === 0) return notFound;

  const aliasesOf = (f: FranchiseRow) => [
    squashFranchise(f.name),
    squashFranchise(f.abbreviation ?? ""),
    squashFranchise(`${f.name} ${f.division ?? ""}`),
    squashFranchise(`${f.abbreviation ?? ""} ${f.division ?? ""}`),
  ];

  const matches = rows.filter((f) => aliasesOf(f).some((alias) => alias.includes(wanted)));
  if (matches.length === 0) return notFound;

  if (matches.length > 1) {
    // An exact "name + division" match wins outright. Otherwise refuse, and
    // say which divisions the name exists in and how to name one of them.
    const exact = matches.filter(
      (f) => squashFranchise(`${f.name} ${f.division ?? ""}`) === wanted
    );
    if (exact.length === 1) return { franchise: exact[0] };

    const names = matches
      .map((f) => `${f.name} (${f.division ?? "no division"})`)
      .join(", ");
    const example = matches[0].division
      ? `${matches[0].name} ${matches[0].division}`
      : matches[0].name;
    return {
      error: `"${input}" matches more than one franchise: ${names}. Add the division to pick one, e.g. "${example}".`,
    };
  }

  return { franchise: matches[0] };
}
