import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Maps a Discord guild (server) to its PitBoss league via
 * rise_os.leagues.discord_server_id. One guild = one league,
 * matching how TRL/WSC/SRH/AARL each run their own Discord server.
 */
export async function resolveLeagueFromGuild(
  guildId: string
): Promise<{ id: string; name: string; slug: string } | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug")
    .eq("discord_server_id", guildId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}
