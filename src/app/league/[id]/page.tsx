"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
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

export default function LeagueDetailPage() {
  const { status } = useSession();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [league, setLeague] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated" && id) fetchLeague();
  }, [status, id]);

  async function fetchLeague() {
    setLoading(true);
    const res = await fetch(`/api/leagues/${id}`);
    if (res.ok) setLeague(await res.json());
    setLoading(false);
  }

  if (status === "loading" || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  if (!league) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <p className="text-white/40">League not found.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      {/* Back */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      {/* Logo */}
      <div className="flex flex-col items-center mb-8">
        {league.logo_url ? (
          <img
            src={league.logo_url}
            alt={league.name}
            className="w-24 h-24 rounded-2xl object-cover mb-4 border border-white/10"
          />
        ) : (
          <div className="w-24 h-24 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-4xl mb-4">
            {SPORT_EMOJI[league.sport] ?? "🏆"}
          </div>
        )}
        <h1 className="text-2xl font-black text-white text-center">{league.name}</h1>
        <p className="text-white/30 text-xs uppercase tracking-widest mt-1">
          {SPORT_LABELS[league.sport] ?? league.sport}
        </p>
      </div>

      {/* Info Cards */}
      <div className="flex flex-col gap-3">
        <InfoRow label="Visibility" value={league.is_public ? "Public" : "Private"} />
        <InfoRow label="Seasons" value={league.season_count ?? 0} />
        <InfoRow
          label="Created"
          value={new Date(league.created_at).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        />
        {league.discord_server_id && (
          <InfoRow label="Discord" value={league.discord_server_id} />
        )}
      </div>
    </main>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between">
      <span className="text-white/40 text-sm">{label}</span>
      <span className="text-white text-sm font-semibold">{String(value)}</span>
    </div>
  );
}
