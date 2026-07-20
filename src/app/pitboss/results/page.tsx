"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface ResultRow {
  id: string;
  driver_id: string;
  round: number;
  track: string | null;
  qualifying_position: number | null;
  finish_position: number | null;
  dnf: boolean;
  fastest_lap: boolean;
  points_earned: number;
  sprint_finish_position: number | null;
  sprint_fastest_lap: boolean;
  sprint_points_earned: number;
  driver: { display_name: string | null; discord_username: string } | null;
}

export default function ResultsPage() {
  const searchParams = useSearchParams();
  const leagueId = searchParams.get("league_id");
  const [season, setSeason] = useState("2026");
  const [round, setRound] = useState<string>("");
  const [leagueName, setLeagueName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leagueId) return;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ league_id: leagueId });
    if (season) params.set("season", season);
    if (round) params.set("round", round);

    fetch(`/api/pitboss/results?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setResults([]);
        } else {
          setLeagueName(data.league_name);
          setLogoUrl(data.league_logo_url);
          setResults(data.results);
        }
      })
      .catch(() => setError("Failed to load results"))
      .finally(() => setLoading(false));
  }, [leagueId, season, round]);

  return (
    <div className="relative min-h-screen bg-black text-white">
      {logoUrl && (
        <div
          className="fixed inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${logoUrl})` }}
        >
          <div className="absolute inset-0 bg-black/80" />
        </div>
      )}

      <div className="relative px-4 pt-6 pb-24">
        <button className="text-neutral-400 text-sm mb-4">← Back</button>

        <h1 className="text-3xl font-bold mb-1">{leagueName || "Results"}</h1>
        <p className="text-xs tracking-widest text-neutral-400 uppercase mb-6">
          Race Results · {season}
          {round ? ` · Round ${round}` : ""}
        </p>

        {!leagueId && (
          <p className="text-neutral-500 text-sm">
            No league selected — this page expects a <code>?league_id=</code> query param.
          </p>
        )}

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {results.length > 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
            {results.map((r, i) => (
              <div
                key={r.id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i !== results.length - 1 ? "border-b border-neutral-800" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-6 text-sm font-semibold ${
                      r.finish_position === 1 ? "text-red-500" : "text-neutral-400"
                    }`}
                  >
                    {r.dnf ? "DNF" : r.finish_position ?? "—"}
                  </span>
                  <div>
                    <p className="font-medium">
                      {r.driver?.display_name ?? r.driver?.discord_username ?? "Unknown"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      Round {r.round}
                      {r.track ? ` · ${r.track}` : ""}
                      {r.qualifying_position ? ` · Q${r.qualifying_position}` : ""}
                      {r.fastest_lap ? " · FL" : ""}
                      {r.sprint_finish_position ? ` · Sprint P${r.sprint_finish_position}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-lg font-bold">
                  {(r.points_earned ?? 0) + (r.sprint_points_earned ?? 0)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
