"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const SPORTS = [
  { id: "cfb", label: "College Football", emoji: "🏈" },
  { id: "nfl", label: "NFL", emoji: "🏈" },
  { id: "nba", label: "NBA", emoji: "🏀" },
  { id: "soccer", label: "Soccer", emoji: "⚽" },
  { id: "nhl", label: "NHL", emoji: "🏒" },
  { id: "sim_racing", label: "Sim Racing", emoji: "🏎️" },
  { id: "other", label: "Other", emoji: "🏆" },
];

export default function LeaguePage() {
  const { status } = useSession();
  const router = useRouter();
  const [leagues, setLeagues] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    name: "",
    sport: "",
    is_public: true,
  });

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") fetchLeagues();
  }, [status]);

  async function fetchLeagues() {
    setLoading(true);
    const res = await fetch("/api/leagues");
    const data = await res.json();
    setLeagues(Array.isArray(data) ? data : []);
    setLoading(false);
  }

  async function createLeague() {
    if (!form.name || !form.sport) return;
    const res = await fetch("/api/leagues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setCreating(false);
      setForm({ name: "", sport: "", is_public: true });
      fetchLeagues();
    }
  }

  if (status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">Leagues</h1>
          <p className="text-xs text-white/30 uppercase tracking-widest">Rise OS</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="rounded-xl bg-rise-red px-4 py-2 text-xs font-bold text-white"
        >
          + New
        </button>
      </div>

      {/* Create League Modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 px-4 pb-8">
          <div className="w-full rounded-2xl border border-white/10 bg-[#111111] p-6">
            <h2 className="text-lg font-black text-white mb-6">Create League</h2>

            <div className="mb-4">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                League Name
              </label>
              <input
                type="text"
                placeholder="e.g. TOPS CFB Dynasty"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            <div className="mb-4">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">
                Sport
              </label>
              <div className="grid grid-cols-2 gap-2">
                {SPORTS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setForm({ ...form, sport: s.id })}
                    className={`rounded-xl border px-3 py-2 text-sm text-left transition-colors ${
                      form.sport === s.id
                        ? "border-rise-red bg-rise-red/10 text-white"
                        : "border-white/10 bg-white/5 text-white/50"
                    }`}
                  >
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-6 flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <span className="text-sm text-white">Public League</span>
              <button
                onClick={() => setForm({ ...form, is_public: !form.is_public })}
                className={`w-12 h-6 rounded-full transition-colors ${
                  form.is_public ? "bg-rise-red" : "bg-white/20"
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full bg-white mx-0.5 transition-transform ${
                    form.is_public ? "translate-x-6" : ""
                  }`}
                />
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setCreating(false)}
                className="flex-1 rounded-xl border border-white/10 py-3 text-sm text-white/50"
              >
                Cancel
              </button>
              <button
                onClick={createLeague}
                disabled={!form.name || !form.sport}
                className="flex-1 rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leagues List */}
      {loading ? (
        <div className="flex justify-center mt-20">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </div>
      ) : leagues.length === 0 ? (
        <div className="flex flex-col items-center justify-center mt-20 gap-4">
          <p className="text-4xl">🏆</p>
          <p className="text-white font-bold">No leagues yet</p>
          <p className="text-white/30 text-sm text-center">
            Create your first league to get started
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {leagues.map((league) => (
            <div
              key={league.id}
              className="rounded-2xl border border-white/10 bg-white/5 p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-bold">{league.name}</p>
                  <p className="text-white/30 text-xs mt-1 uppercase tracking-wide">
                    {league.sport}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded-full ${
                    league.is_public
                      ? "bg-rise-red/20 text-rise-red"
                      : "bg-white/10 text-white/40"
                  }`}
                >
                  {league.is_public ? "Public" : "Private"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
