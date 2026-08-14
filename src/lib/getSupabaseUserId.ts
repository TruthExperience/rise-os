import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

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

/**
 * Resolves the current request's authenticated Supabase Auth user to the
 * corresponding pitboss.drivers row, via public.users.auth_user_id ->
 * public.users.discord_id -> pitboss.drivers.discord_id. Both discord_id
 * columns are unique, confirmed against the live schema.
 *
 * Uses getClaims() rather than getUser() for the same reason as
 * getSupabaseUserId above — see that function's comment.
 *
 * Was added to replace the old getServerSession(authOptions) (next-auth)
 * check still present in some pitboss/cert routes after the Supabase Auth
 * migration — those routes were checking for a session cookie nothing in
 * the app writes anymore, causing 401s that only "worked" via leftover
 * pre-migration next-auth cookies still valid in some browser contexts.
 */
export async function getAuthedDriver(): Promise<{
  id: string;
  discordId: string;
  superLicenceStatus: string;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const authUserId = data?.claims?.sub;
  if (error || !authUserId) return null;

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("discord_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (userError || !userRow?.discord_id) return null;

  const admin = createAdminClient();
  const { data: driver, error: driverError } = await admin
    .schema("pitboss")
    .from("drivers")
    .select("id, discord_id, super_licence_status")
    .eq("discord_id", userRow.discord_id)
    .maybeSingle();

  if (driverError || !driver) return null;
  return {
    id: driver.id,
    discordId: driver.discord_id,
    superLicenceStatus: driver.super_licence_status,
  };
}
