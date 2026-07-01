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
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Matches a franchise's display name (e.g. "Georgia", "Ohio State Buckeyes")
 * to a row in rise_os.cfb_teams. Franchise naming isn't guaranteed to match
 * team_name exactly, so this falls back to nickname and substring matches.
 */
export function findCfbTeam(franchiseName: string, cfbTeams: CfbTeam[]): CfbTeam | null {
  if (!franchiseName || !cfbTeams?.length) return null;
  const target = normalizeTeamName(franchiseName);

  // 1. Exact match on team_name or nickname
  let match = cfbTeams.find(
    (t) =>
      normalizeTeamName(t.team_name) === target ||
      normalizeTeamName(t.nickname ?? "") === target
  );
  if (match) return match;

  // 2. Either name contains the other (handles "App St." vs "Appalachian State")
  match = cfbTeams.find((t) => {
    const tn = normalizeTeamName(t.team_name);
    return tn.length > 2 && (target.includes(tn) || tn.includes(target));
  });
  if (match) return match;

  // 3. Nickname containment (e.g. franchise named "Crimson Tide")
  match = cfbTeams.find((t) => {
    const nn = normalizeTeamName(t.nickname ?? "");
    return nn.length > 2 && (target.includes(nn) || nn.includes(target));
  });
  return match ?? null;
}
