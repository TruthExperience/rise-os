"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export function useAuthStatus(): AuthStatus {
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setStatus(data.user ? "authenticated" : "unauthenticated");
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setStatus(session ? "authenticated" : "unauthenticated");
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return status;
}
