"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const SPORT_EMOJI: Record<string, string> = {
  cfb: "🏈", nfl: "🏈", nba: "🏀",
  soccer: "⚽", nhl: "🏒", sim_racing: "🏎️", other: "🏆",
};

export default function PitBossPage() {
  const { status } = useSession();
  const router = useRouter();
  const [driver, setDriver] = useState<any>(null);
  const [memberships, setMemberships] = useState<any[]>([]);
  const [allLeagues, setAllLeagues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") init();
  }, [status]);

  async function init() {
    setLoading(true);
    try {
      const [driverRes, leaguesRes] = await Promise.all([
        fetch("/api/pitboss/drivers/me"),
        fetch("/api/leagues"),
      ]);
      const driverData = await driverRes.json();
      const leaguesData = await leaguesRes.json();
      setDriver(driverData);
      setDisplayName(driverData.display_name ?? "");
      setAllLeagues(Array.isArray(leaguesData) ? leaguesData.filter((l: any) => l.sport === "sim_racing") : []);
      await fetchMemberships();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchMemberships() {
    const res = await fetch("/api/pitboss/drivers/me/leagues");
    const data = await res.json();
    setMemberships(Array.isArray(data.result) ? data.result : []);
  }

  async function saveDisplayName() {
    const res = await fetch("/api/pitboss/drivers/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    });
    if (res.ok) {
      const updated = await res.json();
      setDriver((prev: any) => ({ ...prev, display_name: updated.display_name }));
      setEditingName(false);
    }
  }

  async function joinLeague(leagueId: string) {
    setJoining(true);
    const res = await fetch("/api/pitboss/drivers/me/leagues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ league_id: leagueId }),
    });
    if (res.ok) await fetchMemberships();
    setJoining(false);
  }

  const joinedLeagueIds = new Set(memberships.map((m) => m.league_id));
  const availableLeagues = allLeagues.filter((l) => !joinedLeagueIds.has(l.id));

  if (status === "loading" || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">PitBoss</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest">Driver Profile</p>
      </div>

      {/* Driver Card */}
      {driver && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6">
          <div className="flex items-center gap-4 mb-4">
            {driver.discord_avatar ? (
              <img src={driver.discord_avatar} alt={driver.discord_username}
                className="w-16 h-16 rounded-full border-2 border-rise-red" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-rise-red/20 border-2 border-rise-red flex items-center justify-center">
                <span className="text-rise-red font-black text-xl">
                  {driver.discord_username?.[0]?.toUpperCase()}
                </span>
              </div>
            )}
            <div className="flex-1">
              {editingName ? (
                <div className="flex gap-2">
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="flex-1 rounded-lg bg-white/10 border border-white/20 px-3 py-1.5 text-white text-sm focus:outline-none focus:border-rise-red"
                    placeholder="Display name"
                    autoFocus
                  />
                  <button onClick={saveDisplayName}
                    className="rounded-lg bg-rise-red px-3 py-1.5 text-xs font-bold text-white">
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <p className="text-white font-black text-lg">
                    {driver.display_name ?? driver.discord_username}
                  </p>
                  <button onClick={() => setEditingName(true)}
                    className="text-white/30 text-xs">✏️</button>
                </div>
              )}
              <p className="text-white/30 text-xs mt-0.5">@{driver.discord_username}</p>
            </div>
          </div>
        </div>
      )}

      {/* Tools */}
      <div className="mb-6">
        <p className="text-xs text-white/40 uppercase tracking-widest mb-3">Tools</p>
        <div
          onClick={() => router.push("/pitboss/setups")}
          className="rounded-2xl border border-white/10 bg-white/5 p-4 cursor-pointer active:scale-95 transition-transform"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rise-red/20 border border-rise-red/30 flex items-center justify-center text-lg">
                🔧
              </div>
              <div>
                <p className="text-white font-bold text-sm">Setup Generator</p>
                <p className="text-white/30 text-xs">Community-weighted setups, tuned by your feedback</p>
              </div>
            </div>
            <span className="text-white/20 text-lg">›</span>
          </div>
        </div>
      </div>

      {/* My Leagues */}
      <div className="mb-6">
        <p className="text-xs text-white/40 uppercase tracking-widest mb-3">My Leagues</p>
        {memberships.length === 0 ? (
          <p className="text-white/20 text-sm">Not registered in any league yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {memberships.map((m) => (
              <div key={m.id}
                onClick={() => router.push(`/pitboss/certify/${m.league_id}`)}
                className="rounded-2xl border border-white/10 bg-white/5 p-4 cursor-pointer active:scale-95 transition-transform"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {m.league?.logo_url ? (
                      <img src={m.league.logo_url} alt={m.league.name}
                        className="w-10 h-10 rounded-xl object-cover border border-white/10" />
                    ) : (
                      <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-lg">
                        🏎️
                      </div>
                    )}
                    <div>
                      <p className="text-white font-bold text-sm">{m.league?.name}</p>
                      <p className="text-white/30 text-xs capitalize">{m.role}</p>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full ${
                    m.certified
                      ? "bg-green-500/20 text-green-400"
                      : "bg-rise-red/20 text-rise-red"
                  }`}>
                    {m.certified ? "Certified ✓" : "Not Certified"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available Leagues to Join */}
      {availableLeagues.length > 0 && (
        <div>
          <p className="text-xs text-white/40 uppercase tracking-widest mb-3">Join a League</p>
          <div className="flex flex-col gap-3">
            {availableLeagues.map((l) => (
              <div key={l.id}
                className="rounded-2xl border border-white/10 bg-white/5 p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  {l.logo_url ? (
                    <img src={l.logo_url} alt={l.name}
                      className="w-10 h-10 rounded-xl object-cover border border-white/10" />
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-lg">
                      {SPORT_EMOJI[l.sport] ?? "🏆"}
                    </div>
                  )}
                  <p className="text-white font-bold text-sm">{l.name}</p>
                </div>
                <button
                  onClick={() => joinLeague(l.id)}
                  disabled={joining}
                  className="rounded-xl bg-rise-red px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
                >
                  Join
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
