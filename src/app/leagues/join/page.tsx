"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const SPORT_EMOJI: Record<string, string> = {
  cfb: "🏈", nfl: "🏈", nba: "🏀",
  soccer: "⚽", nhl: "🏒", sim_racing: "🏎️", other: "🏆",
};

type League = {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  logo_url: string | null;
  season_count: number | null;
  isMember: boolean;
};

export default function JoinLeaguePage() {
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  useEffect(() => {
    fetchLeagues();
  }, []);

  async function fetchLeagues() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/leagues");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }

      setLeagues(Array.isArray(data.leagues) ? data.leagues : []);
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Couldn't load leagues. Please try again.");
      setLeagues([]);
    } finally {
      setLoading(false);
    }
  }

  async function join(league: League) {
    setJoiningId(league.id);
    setErrorId(null);

    try {
      const res = await fetch("/api/leagues/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: league.id }),
      });

      if (res.ok) {
        setLeagues((prev) =>
          prev.map((l) => (l.id === league.id ? { ...l, isMember: true } : l))
        );
        router.refresh();
      } else {
        setErrorId(league.id);
      }
    } catch {
      setErrorId(league.id);
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Join a League</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest">
          Open leagues you can join right now
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center mt-20">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </div>
      ) : error ? (
        <div className="mt-20 flex flex-col items-center gap-4 text-center">
          <p className="text-white/50 text-sm">{error}</p>
          <button
            onClick={fetchLeagues}
            className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm font-medium text-white transition active:scale-95"
          >
            Try again
          </button>
        </div>
      ) : leagues.length === 0 ? (
        <div className="mt-20 flex flex-col items-center gap-1 text-center">
          <p className="text-white/50 text-sm">No leagues are open for joining yet.</p>
          <p className="text-white/30 text-xs">Ask a commissioner if the one you're looking for isn't listed.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {leagues.map((league) => (
            <div
              key={league.id}
              className="rounded-2xl border border-white/10 bg-white/5 p-5"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  {league.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={league.logo_url}
                      alt={league.name}
                      className="w-12 h-12 rounded-xl object-cover border border-white/10 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl flex-shrink-0">
                      {SPORT_EMOJI[league.sport ?? "other"] ?? "🏆"}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-white font-bold truncate">{league.name}</p>
                    <p className="text-white/30 text-xs uppercase tracking-wide mt-0.5">
                      {league.sport ?? "league"}
                      {league.season_count ? ` · Season ${league.season_count}` : ""}
                    </p>
                  </div>
                </div>

                {league.isMember ? (
                  <span className="flex-shrink-0 rounded-full bg-emerald-900/40 px-3 py-1.5 text-xs font-medium text-emerald-400">
                    Joined
                  </span>
                ) : (
                  <button
                    onClick={() => join(league)}
                    disabled={joiningId === league.id}
                    className="flex-shrink-0 rounded-full bg-rise-red px-4 py-1.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-50"
                  >
                    {joiningId === league.id ? "Joining…" : "Join"}
                  </button>
                )}
              </div>

              {errorId === league.id && (
                <p className="mt-3 text-xs text-red-400">
                  Couldn't join. It may not be open yet — try again shortly.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
