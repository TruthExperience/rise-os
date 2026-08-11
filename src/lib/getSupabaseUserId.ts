import { createClient } from "@/lib/supabase/server";

/**
 * Resolves the current request's authenticated Supabase Auth user to the
 * corresponding public.users.id (UUID).
 *
 * Uses getClaims() rather than getUser() — this matches middleware.ts,
 * which verifies sessions the same way and is the one thing confirmed to
 * work reliably. getUser() requires a live round-trip to the Auth server
 * and was returning 401 even immediately after a fresh sign-in, while
 * getClaims() verifies the token locally against the cached JWKS and
 * doesn't have that dependency.
 */
export async function getSupabaseUserId(): Promise<string | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const authUserId = data?.claims?.sub;

  if (error || !authUserId) return null;

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (profileError || !profile) return null;
  return profile.id as string;
}
