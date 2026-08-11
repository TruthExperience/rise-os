import { createClient } from "@/lib/supabase/server";

/**
 * Resolves the current request's authenticated Supabase Auth user to the
 * corresponding public.users.id (UUID).
 *
 * This used to take a NextAuth `Session` and resolve via session.user.discordId.
 * Auth is now handled entirely by Supabase Auth (see src/app/login/page.tsx
 * and src/app/auth/callback/route.ts) — getServerSession(authOptions) has
 * had no session to read since that migration, since login only ever
 * writes a Supabase Auth session, not a NextAuth one.
 */
export async function getSupabaseUserId(): Promise<string | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return data.id as string;
}
