import { Session } from "next-auth";
import { supabaseServer } from "./supabaseServer";

/**
 * Explicit-param replacement for RLS-based pitboss.has_league_role().
 * The RLS version relies on auth.jwt(), which is never populated (no
 * Supabase Auth session exists in this app — auth is NextAuth/Discord
 * only). Call this from API routes to do the same check in app code.
 *
 * Usage:
 *   const isCommissioner = await hasLeagueRole(session, leagueId, "commissioner");
 *   if (!isCommissioner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */
export async function hasLeagueRole(
  session: Session | null,
  leagueId: string,
  minRole: "driver" | "reserve" | "steward" | "commissioner"
): Promise<boolean> {
  const discordId = (session?.user as any)?.discordId as string | undefined;
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
export async function getDriverId(session: Session | null): Promise<string | null> {
  const discordId = (session?.user as any)?.discordId as string | undefined;
  if (!discordId) return null;

  const { data, error } = await supabaseServer
    .schema("pitboss")
    .rpc("get_driver_id", { p_discord_id: discordId });

  if (error || !data) return null;
  return data as string;
}
