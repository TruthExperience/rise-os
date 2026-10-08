import type { AppSession } from "@/lib/session";
import { supabaseServer } from "./supabaseServer";

/**
 * Explicit-param replacement for RLS-based pitboss.has_league_role().
 * The RLS version relies on auth.jwt(), which isn't populated for the
 * service-role client these routes use, so this does the same check in app
 * code. Pass the session from getSession() (src/lib/session.ts).
 *
 * Usage:
 *   const session = await getSession();
 *   const isCommissioner = await hasLeagueRole(session, leagueId, "commissioner");
 *   if (!isCommissioner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */
export async function hasLeagueRole(
  session: AppSession | null,
  leagueId: string,
  minRole: "driver" | "reserve" | "steward" | "commissioner"
): Promise<boolean> {
  const discordId = session?.user?.discordId;
  if (!discordId) return false;

  const { data, error } = await supabaseServer
    .schema("pitboss")
    .rpc("has_league_role", {
      p_discord_id: discordId,
      league: leagueId,
      min_role: minRole,
    });

  if (error) return false;
  return Boolean(data);
}

/** Explicit-param replacement for pitboss.get_driver_id(). */
export async function getDriverId(session: AppSession | null): Promise<string | null> {
  const discordId = session?.user?.discordId;
  if (!discordId) return null;

  const { data, error } = await supabaseServer
    .schema("pitboss")
    .rpc("get_driver_id", { p_discord_id: discordId });

  if (error || !data) return null;
  return data as string;
}
