"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type SessionUser = {
  id?: string;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  image?: string | null;
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

    async function loadSession(authUser: any) {
      if (!authUser) {
        if (mounted) {
          setSession(null);
          setStatus("unauthenticated");
        }
        return;
      }

      const { data: profile } = await supabase
        .from("users")
        .select("id, username, avatar, email")
        .eq("auth_user_id", authUser.id)
        .single();

      if (!mounted) return;
      setSession({
        user: {
          id: profile?.id ?? authUser.id,
          name: profile?.username ?? authUser.email,
          username: profile?.username ?? authUser.email,
          email: profile?.email ?? authUser.email,
          image: profile?.avatar ?? null,
        },
      });
      setStatus("authenticated");
    }

    supabase.auth.getUser().then(({ data }) => loadSession(data.user));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, sessionData) => {
      loadSession(sessionData?.user ?? null);
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
