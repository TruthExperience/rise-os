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
  discordId: string;
  superLicenceStatus: string;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const authUserId = data?.claims?.sub;
  if (error || !authUserId) return null;

  let userRow: { discord_id: string | null } | null = null;
  {
    const { data: row, error: rowError } = await supabase
      .from("users")
      .select("discord_id")
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
      .select("discord_id")
      .eq("id", healedId)
      .maybeSingle();
    userRow = row ?? null;
  }

  if (!userRow?.discord_id) return null;

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

/**
 * Links or creates the public.users row for an authenticated Supabase Auth
 * user, mirroring handle_new_auth_user()'s matching logic (discord_id ->
 * email -> create new) but callable from app code as a retry path. Uses
 * the admin client to bypass RLS, same pattern as getAuthedDriver.
 *
 * Safe to call repeatedly / concurrently: the final step upserts on the
 * auth_user_id unique constraint, so duplicate calls just no-op onto the
 * same row rather than erroring or creating duplicates.
 */
async function healMissingProfileLink(authUserId: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(authUserId);
  if (authUserError || !authUser?.user?.email) {
    console.error("healMissingProfileLink: could not load auth user", authUserId, authUserError);
    return null;
  }

  const email = authUser.user.email;
  const meta = authUser.user.user_metadata ?? {};
  const discordId: string | null = meta.provider_id ?? meta.sub ?? null;
  const username: string | null =
    meta.user_name ?? meta.full_name ?? meta.name ?? email.split("@")[0];
  const avatar: string | null = meta.avatar_url ?? null;

  // 1. Try to link an existing unlinked row by discord_id, then email —
  //    same precedence as handle_new_auth_user().
  const matchColumn = discordId ? "discord_id" : "email";
  const matchValue = discordId ?? email;

  if (matchValue) {
    const { data: existing } = await admin
      .from("users")
      .select("id")
      .eq(matchColumn, matchValue)
      .is("auth_user_id", null)
      .maybeSingle();

    if (existing) {
      const { data: linked, error: linkError } = await admin
        .from("users")
        .update({ auth_user_id: authUserId })
        .eq("id", existing.id)
        .select("id")
        .maybeSingle();

      if (!linkError && linked) return linked.id as string;

      console.error("healMissingProfileLink: failed to link existing row", existing.id, linkError);
    }
  }

  // 2. Nobody to link to — create the row now, same fallback as
  //    handle_new_auth_user()'s step 3.
  const { data: created, error: createError } = await admin
    .from("users")
    .upsert(
      {
        auth_user_id: authUserId,
        discord_id: discordId,
        email,
        username,
        avatar,
      },
      { onConflict: "auth_user_id" }
    )
    .select("id")
    .maybeSingle();

  if (createError || !created) {
    console.error("healMissingProfileLink: failed to create profile row", authUserId, createError);
    return null;
  }

  return created.id as string;
}
