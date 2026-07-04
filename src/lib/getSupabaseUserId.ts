import { Session } from "next-auth";
import { supabaseServer } from "./supabaseServer";

/**
 * session.user.id is NOT the public.users.id UUID — with the JWT strategy
 * and no database adapter, NextAuth sets token.sub (and thus session.user.id)
 * from the Discord OAuth profile id, i.e. it's the Discord snowflake ID.
 * The actual Supabase UUID has to be looked up via discord_id.
 */
export async function getSupabaseUserId(
  session: Session | null
): Promise<string | null> {
  const discordId = (session?.user as any)?.discordId as string | undefined;
  if (!discordId) return null;

  const { data, error } = await supabaseServer
    .from("users")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error || !data) return null;
  return data.id as string;
}
