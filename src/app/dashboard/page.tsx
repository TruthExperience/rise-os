"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

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

  if (!session) return null;

  const user = session.user as any;

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
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/50 hover:text-white transition-colors"
        >
          Sign Out
        </button>
      </div>

      {/* User Card */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">
        <div className="flex items-center gap-4">
          {user?.image && (
            <img
              src={user.image}
              alt="avatar"
              className="h-14 w-14 rounded-full border-2 border-rise-red"
            />
          )}
          <div>
            <p className="text-white font-bold text-lg">
              {user?.username || user?.name}
            </p>
            <p className="text-white/40 text-sm">
              {user?.email}
            </p>
            <p className="text-rise-red text-xs mt-1 font-medium uppercase tracking-wide">
              Commissioner
            </p>
          </div>
        </div>
      </div>

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
