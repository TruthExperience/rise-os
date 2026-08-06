"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  id: string;
  username: string | null;
  avatar: string | null;
  email: string | null;
};

export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data } = await supabase.auth.getUser();
      const authUser = data?.user;

      if (!authUser) {
        if (mounted) setStatus("unauthenticated");
        return;
      }

      const { data: userRow } = await supabase
        .from("users")
        .select("id, username, avatar, email")
        .eq("auth_user_id", authUser.id)
        .single();

      if (!mounted) return;
      setProfile(userRow ?? { id: authUser.id, username: authUser.email, avatar: null, email: authUser.email });
      setStatus("authenticated");
    }

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setStatus("unauthenticated");
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
          <p className="text-white/40 text-sm">Loading Rise OS...</p>
        </div>
      </main>
    );
  }

  if (!profile) return null;

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">
            Rise <span className="text-rise-red">OS</span>
          </h1>
          <p className="text-xs text-white/30 uppercase tracking-widest">
            Dashboard
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/50 hover:text-white transition-colors"
        >
          Sign Out
        </button>
      </div>

      {/* User Card — tappable */}
      <Link href="/pitboss/profile">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6 active:scale-[0.98] transition-transform">
          <div className="flex items-center gap-4">
            {profile.avatar && (
              <img
                src={profile.avatar}
                alt="avatar"
                className="h-14 w-14 rounded-full border-2 border-rise-red"
              />
            )}
            <div className="flex-1">
              <p className="text-white font-bold text-lg">{profile.username}</p>
              <p className="text-white/40 text-sm">{profile.email}</p>
              <p className="text-rise-red text-xs mt-1 font-medium uppercase tracking-wide">
                Commissioner
              </p>
            </div>
            <span className="text-white/20 text-lg">›</span>
          </div>
        </div>
      </Link>

      {/* Module Grid */}
      <p className="text-white/30 text-xs uppercase tracking-widest mb-3">
        Modules
      </p>
      <div className="grid grid-cols-2 gap-3">
        {[
          { name: "Pitboss", icon: "🎓", status: "Certification", href: "/pitboss/cert" },
          { name: "Governance", icon: "⚖️", status: "Soon" },
          { name: "Franchise", icon: "🏟️", status: "Soon" },
          { name: "Season Ops", icon: "📅", status: "Soon" },
          { name: "Draft", icon: "📋", status: "Soon" },
          { name: "Discord", icon: "💬", status: "Soon" },
          { name: "Coaching", icon: "🎯", status: "Soon" },
        ].map((module) =>
          module.href ? (
            <button
              key={module.name}
              onClick={() => router.push(module.href)}
              className="rounded-xl border border-rise-red/40 bg-rise-red/10 p-4 flex flex-col gap-2 text-left active:scale-[0.98] transition-transform"
            >
              <span className="text-2xl">{module.icon}</span>
              <p className="text-sm font-semibold text-white">{module.name}</p>
              <span className="text-xs text-rise-red font-medium">{module.status}</span>
            </button>
          ) : (
            <div
              key={module.name}
              className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-2"
            >
              <span className="text-2xl">{module.icon}</span>
              <p className="text-sm font-semibold text-white">{module.name}</p>
              <span className="text-xs text-white/30">{module.status}</span>
            </div>
          )
        )}
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-white/20 mt-10">
        TOPS Ecosystem · Rise OS v0.1
      </p>
    </main>
  );
}
