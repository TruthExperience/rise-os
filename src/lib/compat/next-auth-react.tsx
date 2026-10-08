"use client";

// Supabase-backed stand-in for "next-auth/react".
//
// Every page imports useSession/signIn/signOut/SessionProvider from
// "next-auth/react". Both webpack (next.config.js alias) and TypeScript
// (tsconfig "paths") resolve that specifier to this file, so no page needs
// editing and the real next-auth package is no longer installed.

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type SessionUser = {
  /** public.users.id (UUID), or the auth user id if no profile row exists yet. */
  id?: string;
  /** Discord snowflake. Undefined for accounts with no Discord link. */
  discordId?: string;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  image?: string | null;
  avatar?: string | null;
};

type Session = { user: SessionUser } | null;
type Status = "loading" | "authenticated" | "unauthenticated";

const SessionContext = createContext<{ session: Session; status: Status }>({
  session: null,
  status: "loading",
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getClaims();
      const claims = data?.claims;
      const authUserId = claims?.sub;

      if (error || !authUserId) {
        if (mounted) {
          setSession(null);
          setStatus("unauthenticated");
        }
        return;
      }

      const { data: profile } = await supabase
        .from("users")
        .select("id, username, avatar, email, discord_id")
        .eq("auth_user_id", authUserId)
        .single();

      if (!mounted) return;

      // Discord OAuth stores the snowflake in user_metadata.provider_id; use it
      // as a fallback if the profile row can't be read or has no discord_id.
      const metaDiscordId = (claims as any)?.user_metadata?.provider_id as
        | string
        | undefined;
      const discordId: string | undefined =
        profile?.discord_id ?? metaDiscordId ?? undefined;

      setSession({
        user: {
          id: profile?.id ?? authUserId,
          discordId,
          name: profile?.username ?? claims?.email,
          username: profile?.username ?? claims?.email,
          email: profile?.email ?? claims?.email,
          image: profile?.avatar ?? null,
          avatar: profile?.avatar ?? null,
        },
      });
      setStatus("authenticated");
    }

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      loadSession();
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return (
    <SessionContext.Provider value={{ session, status }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const { session, status } = useContext(SessionContext);
  return { data: session, status };
}

export async function signOut(options?: { callbackUrl?: string }) {
  const supabase = createClient();
  await supabase.auth.signOut();
  if (options?.callbackUrl) window.location.href = options.callbackUrl;
}

export async function signIn(provider?: string, options?: { callbackUrl?: string }) {
  const supabase = createClient();
  if (provider === "discord") {
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${options?.callbackUrl ?? "/dashboard"}`,
      },
    });
  }
}
