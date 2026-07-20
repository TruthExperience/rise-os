"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface StandingRow {
  position: number;
  driver_id: string;
  driver_name: string;
  wins: number;
  poles: number;
  fastest_laps: number;
  dnfs: number;
  sprint_wins: number;
  points: number;
}

export default function StandingsPage() {
  const searchParams = useSearchParams();
  const leagueId = searchParams.get("league_id");
  const [season, setSeason] = useState("2026");
  const [leagueName, setLeagueName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leagueId || !season) return;
    setLoading(true);
    setError(null);

    fetch(`/api/pitboss/standings?league_id=${leagueId}&season=${season}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setStandings([]);
        } else {
          setLeagueName(data.league_name);
          setLogoUrl(data.league_logo_url);
          setStandings(data.standings);
        }
      })
      .catch(() => setError("Failed to load standings"))
      .finally(() => setLoading(false));
  }, [leagueId, season]);

  return (
    <div className="relative min-h-screen bg-black text-white">
      {/* Full-bleed league logo background, dark overlay for readability.
          Falls back to a plain dark background if the league has no logo
          uploaded yet (currently: Apex World Championship, Aero Aces
          Racing League, Slipstream Racing Hub). */}
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

        <h1 className="text-3xl font-bold mb-1">{leagueName || "Standings"}</h1>
        <p className="text-xs tracking-widest text-neutral-400 uppercase mb-6">
          Driver Championship · {season}
        </p>

        {!leagueId && (
          <p className="text-neutral-500 text-sm">
            No league selected — this page expects a <code>?league_id=</code> query param.
          </p>
        )}

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {standings.length > 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
            {standings.map((row, i) => (
              <div
                key={row.driver_id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i !== standings.length - 1 ? "border-b border-neutral-800" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-6 text-sm font-semibold ${
                      row.position === 1 ? "text-red-500" : "text-neutral-400"
                    }`}
                  >
                    {row.position}
                  </span>
                  <div>
                    <p className="font-medium">{row.driver_name}</p>
                    <p className="text-xs text-neutral-500">
                      {row.wins} wins · {row.poles} poles · {row.fastest_laps} FL · {row.dnfs} DNF
                      {row.sprint_wins > 0 ? ` · ${row.sprint_wins} sprint wins` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-lg font-bold">{row.points}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
