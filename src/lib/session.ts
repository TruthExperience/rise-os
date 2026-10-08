// src/lib/session.ts
//
// Server-side session for API routes and server code.
//
// Replaces next-auth's getServerSession(authOptions). Sign-in now happens
// through Supabase Auth (Discord OAuth or email/password), so the only
// session that exists is the Supabase cookie session. This helper reads that
// session and returns it in the same shape the old NextAuth session had, so
// routes only need to swap `getServerSession(authOptions)` for `getSession()`.
//
// Resolution: auth session -> claims.sub -> public.users.auth_user_id ->
// public.users row (discord_id, username, avatar, email).
//
// Server-only. Never import this into a "use client" component.

import {
  createClient,
  createAdminClient,
  healMissingProfileLink,
} from "@/lib/supabase/server";

export type AppSessionUser = {
  /**
   * Discord snowflake when the account has one (the same value NextAuth used
   * to expose as session.user.id), otherwise the public.users.id UUID.
   */
  id: string;
  /** public.users.id (UUID). */
  userId: string;
  /** Discord snowflake. Undefined for accounts with no Discord link (e.g. email sign-ups). */
  discordId?: string;
  username?: string;
  name?: string;
  email?: string;
  avatar: string | null;
  image: string | null;
};

export type AppSession = { user: AppSessionUser };

const USER_COLUMNS = "id, discord_id, username, avatar, email";

/**
 * Returns the signed-in user, or null if there is no valid session.
 *
 * Uses getClaims() rather than getUser() for the same reason as the rest of
 * the app (see getSupabaseUserId): it verifies the token locally and doesn't
 * depend on a live round-trip to the Auth server.
 */
export async function getSession(): Promise<AppSession | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    const authUserId = data?.claims?.sub;
    if (error || !authUserId) return null;

    const admin = createAdminClient();

    let { data: row } = await admin
      .from("users")
      .select(USER_COLUMNS)
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    // Validly authenticated but no linked public.users row yet (e.g. a
    // password sign-in that never passed through /auth/callback). Link or
    // create it now, same self-heal as getSupabaseUserId / getAuthedDriver.
    if (!row) {
      const healedId = await healMissingProfileLink(authUserId);
      if (!healedId) return null;

      const healed = await admin
        .from("users")
        .select(USER_COLUMNS)
        .eq("id", healedId)
        .maybeSingle();
      row = healed.data;
    }

    if (!row) return null;

    const discordId: string | undefined = row.discord_id ?? undefined;
    const username: string | undefined = row.username ?? undefined;
    const email: string | undefined = row.email ?? undefined;
    const avatar: string | null = row.avatar ?? null;

    return {
      user: {
        id: discordId ?? (row.id as string),
        userId: row.id as string,
        discordId,
        username,
        name: username,
        email,
        avatar,
        image: avatar,
      },
    };
  } catch (err) {
    // Fail closed: treat any unexpected error as "not signed in".
    console.error("[getSession] failed:", err);
    return null;
  }
}
