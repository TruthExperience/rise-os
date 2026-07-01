"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { findCfbTeam, CfbTeam } from "@/lib/matchCfbTeam";

function getAvatarUrl(discordId: string | null, avatar: string | null) {
  if (!discordId || !avatar) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`;
}

export default function FranchiseListPage() {
  const { status } = useSession();
  const router = useRouter();
  const { leagueId } = useParams<{ leagueId: string }>();
  const [franchises, setFranchises] = useState<any[]>([]);
  const [league, setLeague] = useState<any>(null);
  const [cfbTeams, setCfbTeams] = useState<CfbTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", abbreviation: "", primary_color: "#E8284A", secondary_color: "#ffffff" });

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (leagueId) {
      fetchLeague();
      fetchFranchises();
      fetchCfbTeams();
    }
  }, [leagueId]);

  async function fetchLeague() {
    const res = await fetch(`/api/leagues/${leagueId}`);
    if (res.ok) setLeague(await res.json());
  }

  async function fetchFranchises() {
    setLoading(true);
    try {
      const res = await fetch(`/api/franchises/${leagueId}`);
      const data = await res.json();
      setFranchises(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchCfbTeams() {
    try {
      const res = await fetch("/api/cfb-teams");
      if (res.ok) setCfbTeams(await res.json());
    } catch (e) {
      console.error(e);
    }
  }

  async function createFranchise() {
    if (!form.name) return;
    const res = await fetch(`/api/franchises/${leagueId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setCreating(false);
      setForm({ name: "", abbreviation: "", primary_color: "#E8284A", secondary_color: "#ffffff" });
      fetchFranchises();
    }
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="flex items-center gap-2 text-white/40 text-sm mb-6">
        ← Back
      </button>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">Franchises</h1>
          <p className="text-xs text-white/30 uppercase tracking-widest">{league?.name}</p>
        </div>
        <button onClick={() => setCreating(true)}
          className="rounded-xl bg-rise-red px-4 py-2 text-xs font-bold text-white">
          + New
        </button>
      </div>

      {/* Create Modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 px-4 pb-8">
          <div className="w-full rounded-2xl border border-white/10 bg-[#111111] p-6">
            <h2 className="text-lg font-black text-white mb-6">Create Franchise</h2>

            <div className="mb-4">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Team Name</label>
              <input type="text" placeholder="e.g. Atlanta Knights"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            <div className="mb-4">
              <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Abbreviation</label>
              <input type="text" placeholder="e.g. ATL" maxLength={5}
                value={form.abbreviation}
                onChange={(e) => setForm({ ...form, abbreviation: e.target.value.toUpperCase() })}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            <div className="mb-6 grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Primary Color</label>
                <div className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                  <input type="color" value={form.primary_color}
                    onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer bg-transparent border-0" />
                  <span className="text-white text-sm">{form.primary_color}</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-white/40 uppercase tracking-widest mb-2 block">Secondary Color</label>
                <div className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                  <input type="color" value={form.secondary_color}
                    onChange={(e) => setForm({ ...form, secondary_color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer bg-transparent border-0" />
                  <span className="text-white text-sm">{form.secondary_color}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setCreating(false)}
                className="flex-1 rounded-xl border border-white/10 py-3 text-sm text-white/50">
                Cancel
              </button>
              <button onClick={createFranchise} disabled={!form.name}
                className="flex-1 rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40">
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center mt-20">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </div>
      ) : franchises.length === 0 ? (
        <div className="flex flex-col items-center justify-center mt-20 gap-4">
          <p className="text-4xl">🏟️</p>
          <p className="text-white font-bold">No franchises yet</p>
          <p className="text-white/30 text-sm text-center">Create the first team in this league</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {franchises.map((f) => {
            const cfbTeam = findCfbTeam(f.name, cfbTeams);
            const gmAvatarUrl = f.gm ? getAvatarUrl(f.gm.discord_id, f.gm.avatar) : null;
            return (
              <div key={f.id}
                onClick={() => router.push(`/franchise/${leagueId}/${f.id}`)}
                className="rounded-2xl border border-white/10 bg-white/5 p-5 cursor-pointer active:scale-95 transition-transform"
              >
                <div className="flex items-center gap-4">
                  {f.logo_url ? (
                    <img src={f.logo_url} alt={f.name}
                      className="w-12 h-12 rounded-xl object-cover border border-white/10 flex-shrink-0" />
                  ) : (
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border border-white/10"
                      style={{ backgroundColor: f.primary_color ?? "#ffffff20" }}>
                      <span className="text-white font-black text-sm">{f.abbreviation ?? f.name.slice(0, 3).toUpperCase()}</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold truncate">{f.name}</p>
                    <p className="text-white/30 text-xs mt-0.5">{f.wins ?? 0}W – {f.losses ?? 0}L · {f.championships ?? 0} 🏆</p>
                  </div>
                  {cfbTeam && cfbTeam.ovr != null && (
                    <div className="flex-shrink-0 text-center rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                      <p className="text-white font-black text-lg leading-none">{cfbTeam.ovr}</p>
                      <p className="text-white/30 text-[10px] uppercase tracking-widest mt-0.5">OVR</p>
                    </div>
                  )}
                </div>

                {f.gm && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/rise/gm/${f.gm.id}`);
                    }}
                    className="mt-3 pt-3 border-t border-white/5 w-full flex items-center gap-2 text-left"
                  >
                    {gmAvatarUrl ? (
                      <img src={gmAvatarUrl} alt={f.gm.username}
                        className="w-6 h-6 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                        <span className="text-white/50 text-[10px] font-black">{f.gm.username[0]?.toUpperCase()}</span>
                      </div>
                    )}
                    <span className="text-white/30 text-xs">GM</span>
                    <span className="text-white/70 text-xs font-semibold truncate">{f.gm.username}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
