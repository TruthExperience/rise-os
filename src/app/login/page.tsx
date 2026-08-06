"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  async function signInWithDiscord() {
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
    });
  }

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
            },
          });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (mode === "signin") {
      window.location.href = "/dashboard";
    } else {
      setError("Check your email to confirm your account.");
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-6">
      {/* Logo */}
      <div className="mb-8 flex flex-col items-center gap-2">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-rise-red">
          <span className="text-3xl font-black text-white">R</span>
        </div>
        <h1 className="text-4xl font-black tracking-tight text-white">
          Rise <span className="text-rise-red">OS</span>
        </h1>
        <p className="text-sm text-white/50 tracking-widest uppercase">
          Sports Dynasty Governance
        </p>
      </div>

      {/* Login Card */}
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8">
        <h2 className="text-xl font-bold text-white mb-2">Welcome</h2>
        <p className="text-sm text-white/40 mb-8">
          Sign in with Discord or your email to access your league.
        </p>

        <button
          onClick={signInWithDiscord}
          className="w-full flex items-center justify-center gap-3 rounded-xl bg-[#5865F2] hover:bg-[#4752C4] transition-colors px-6 py-4 text-white font-semibold text-sm"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
          </svg>
          Continue with Discord
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3 my-6">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-xs text-white/30 uppercase tracking-wider">or</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {/* Email form */}
        <form onSubmit={handleEmailAuth} className="flex flex-col gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-rise-red transition-colors"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            minLength={6}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-rise-red transition-colors"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-rise-red hover:opacity-90 disabled:opacity-50 transition-opacity px-6 py-3 text-white font-semibold text-sm"
          >
            {loading ? "Please wait..." : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        {error && (
          <p className="text-xs text-rise-red text-center mt-4">{error}</p>
        )}

        <button
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="w-full text-xs text-white/40 hover:text-white/60 text-center mt-6 transition-colors"
        >
          {mode === "signin"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>

        <p className="text-xs text-white/20 text-center mt-6">
          By signing in you agree to the Rise OS terms of use.
        </p>
      </div>

      {/* Footer */}
      <p className="mt-8 text-xs text-white/20">TOPS Ecosystem · Rise OS v0.1</p>
    </main>
  );
}
