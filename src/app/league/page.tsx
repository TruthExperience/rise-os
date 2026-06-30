"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const SPORT_LABELS: Record<string, string> = {
  cfb: "College Football",
  nfl: "NFL",
  nba: "NBA",
  soccer: "Soccer",
  nhl: "NHL",
  sim_racing: "Sim Racing",
  other: "Other",
};

const SPORT_EMOJI: Record<string, string> = {
  cfb: "🏈",
  nfl: "🏈",
  nba: "🏀",
  soccer: "⚽",
  nhl: "🏒",
  sim_racing: "🏎️",
  other: "🏆",
};

interface LeagueSummary {
  league_id: string;
  name: string;
  sport: string;
  logo_url?: string | null;
  role: string;
}

export default function LeaguePickerPage() {
  const { status } = useSession();
  const router = useRouter();
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated") fetchLeagues();
  }, [status]);

  async function fetchLeagues() {
    setLoading(true);
    try {
      const res = await fetch("/api/pitboss/me/leagues");
      if (res.ok) {
        const data = await res.json();
        setLeagues(data.leagues ?? []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading" || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  if (leagues.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black px-4">
        <p className="text-white/40 text-center">
          You're not a member of any leagues yet.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Leagues</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          Select a league
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {leagues.map((league) => (
          <button
            key={league.league_id}
            onClick={() => router.push(`/league/${league.league_id}`)}
            className="rounded-2xl border border-white/10 bg-white/5 p-4 flex items-center gap-4 text-left active:scale-[0.98] transition-transform"
          >
            {league.logo_url ? (
              <img
                src={league.logo_url}
                alt={league.name}
                className="w-14 h-14 rounded-xl object-cover border border-white/10 flex-shrink-0"
              />
            ) : (
              <div className="w-14 h-14 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl flex-shrink-0">
                {SPORT_EMOJI[league.sport] ?? "🏆"}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-base leading-tight truncate">
                {league.name}
              </p>
              <p className="text-white/30 text-xs uppercase tracking-widest mt-1">
                {SPORT_LABELS[league.sport] ?? league.sport}
              </p>
            </div>
            <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-white/5 text-white/40 flex-shrink-0">
              {league.role.split(",")[0]?.trim()}
            </span>
          </button>
        ))}
      </div>
    </main>
  );
}
