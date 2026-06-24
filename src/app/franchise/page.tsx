"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const SPORT_EMOJI: Record<string, string> = {
  cfb: "🏈", nfl: "🏈", nba: "🏀",
  soccer: "⚽", nhl: "🏒", sim_racing: "🏎️", other: "🏆",
};

export default function FranchiseIndexPage() {
  const { status } = useSession();
  const router = useRouter();
  const [leagues, setLeagues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    fetchLeagues();
  }, []);

  async function fetchLeagues() {
    setLoading(true);
    try {
      const res = await fetch("/api/leagues");
      const data = await res.json();
      setLeagues(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Franchises</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest">Select a League</p>
      </div>

      {loading ? (
        <div className="flex justify-center mt-20">
          <div className="h-8 w-8 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {leagues.map((league) => (
            <div
              key={league.id}
              onClick={() => router.push(`/franchise/${league.id}`)}
              className="rounded-2xl border border-white/10 bg-white/5 p-5 cursor-pointer active:scale-95 transition-transform"
            >
              <div className="flex items-center gap-4">
                {league.logo_url ? (
                  <img src={league.logo_url} alt={league.name}
                    className="w-12 h-12 rounded-xl object-cover border border-white/10 flex-shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl flex-shrink-0">
                    {SPORT_EMOJI[league.sport] ?? "🏆"}
                  </div>
                )}
                <div>
                  <p className="text-white font-bold">{league.name}</p>
                  <p className="text-white/30 text-xs uppercase tracking-wide mt-0.5">{league.sport}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
