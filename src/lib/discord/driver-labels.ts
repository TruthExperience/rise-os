// FILE: src/lib/discord/driver-labels.ts   (new file)
// League-scoped driver display info for Discord posts and card images.
// Source: pitboss.driver_leagues.league_name / driver_number / flag, falling
// back to pitboss.drivers.display_name / discord_username when a driver has no
// league-specific values (so other leagues are unaffected). Never throws.
export type DriverLabel = { name: string; number: number | null; flag: string | null };

export async function loadDriverLabels(
  pb: any,
  leagueId: string,
  driverIds: string[]
): Promise<Record<string, DriverLabel>> {
  const out: Record<string, DriverLabel> = {};
  if (!driverIds.length) return out;
  try {
    const [{ data: drivers }, { data: dl }] = await Promise.all([
      pb.from("drivers").select("id, discord_username, display_name").in("id", driverIds),
      pb
        .from("driver_leagues")
        .select("driver_id, league_name, driver_number, flag")
        .eq("league_id", leagueId)
        .in("driver_id", driverIds),
    ]);
    const byDriver = Object.fromEntries((dl ?? []).map((r: any) => [r.driver_id, r]));
    for (const d of drivers ?? []) {
      const l = byDriver[d.id];
      out[d.id] = {
        name: l?.league_name || d.display_name || d.discord_username || "Unknown",
        number: l?.driver_number ?? null,
        flag: l?.flag ?? null,
      };
    }
  } catch {
    /* fall through: callers use "Unknown" for missing ids */
  }
  return out;
}

export const labelPlain = (l?: DriverLabel) =>
  l ? `${l.number != null ? `#${l.number} ` : ""}${l.name}` : "Unknown";

export const labelFull = (l?: DriverLabel) =>
  l ? `${labelPlain(l)}${l.flag ? ` ${l.flag}` : ""}` : "Unknown";
