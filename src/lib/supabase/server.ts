import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

// Cookie-based client for use in Server Components and Route Handlers
// that need RLS to respect the logged-in user's session.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from a Server Component — cookies can't be set.
            // Middleware handles session refresh so this is safe to ignore.
          }
        },
      },
    }
  )
}

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

  if (!profileError && profile) return profile.id as string;

  // No linked public.users row for a validly authenticated session. This
  // happens when handle_new_auth_user() couldn't link/create a row at
  // signup time (its EXCEPTION handler now lets auth.users succeed
  // anyway — see migration harden_handle_new_auth_user_never_block_signup)
  // and the user never passed through /auth/callback to retry the link,
  // e.g. a password sign-in, which redirects straight to /dashboard and
  // never hits that route. Heal it here instead of returning null forever.
  return healMissingProfileLink(authUserId);
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
  discordId: string | null;
  superLicenceStatus: string;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const authUserId = data?.claims?.sub;
  if (error || !authUserId) return null;

  let userRow: { id: string; discord_id: string | null } | null = null;
  {
    const { data: row, error: rowError } = await supabase
      .from("users")
      .select("id, discord_id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (!rowError && row) userRow = row;
  }

  // Same self-heal fallback as getSupabaseUserId — this depends on the
  // exact same public.users row, so it's exposed to the exact same gap.
  if (!userRow) {
    const healedId = await healMissingProfileLink(authUserId);
    if (!healedId) return null;

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("users")
      .select("id, discord_id")
      .eq("id", healedId)
      .maybeSingle();
    userRow = row ?? null;
  }

  if (!userRow) return null;

  // pitboss.drivers can be linked by discord_id (the original, bot-driven
  // registration path) or by user_id (drivers_user_id_fkey -> public.users.id,
  // which is the only link available for accounts with no Discord — e.g.
  // email/password signups). Match on whichever is present; discord_id is
  // no longer NOT NULL here (see migration allow_null_discord_id_on_pitboss_drivers),
  // so a driver row can legitimately have only one of the two set.
  const admin = createAdminClient();
  const orFilters = [`user_id.eq.${userRow.id}`];
  if (userRow.discord_id) orFilters.push(`discord_id.eq.${userRow.discord_id}`);

  const { data: driver, error: driverError } = await admin
    .schema("pitboss")
    .from("drivers")
    .select("id, discord_id, super_licence_status")
    .or(orFilters.join(","))
    .maybeSingle();

  if (driverError || !driver) return null;
  return {
    id: driver.id,
    discordId: driver.discord_id,
    superLicenceStatus: driver.super_licence_status,
  };
}

/**
 * Links or creates the public.users row for an authenticated Supabase Auth
 * user, mirroring handle_new_auth_user()'s matching logic (discord_id ->
 * email -> create new) but callable from app code as a retry path. Uses
 * the adm
