"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

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

interface TeamRow {
  position: number;
  franchise_id: string;
  team_name: string;
  abbreviation: string | null;
  logo_url: string | null;
  color: string | null;
  wins: number;
  poles: number;
  fastest_laps: number;
  dnfs: number;
  points: number;
}

interface LeagueSummary {
  league_id: string;
  name: string;
  sport: string;
  logo_url?: string | null;
  role: string;
}

function StandingsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlLeagueId = searchParams.get("league_id");

  // BottomNav links here with no league context at all (it's a global nav
  // bar, it has no way to know which league is "current"). So when the URL
  // doesn't supply one, resolve it the same way /league does: fetch the
  // driver's memberships and either auto-pick the only one or let them
  // choose, instead of dead-ending on an error message.
  const [resolvingLeague, setResolvingLeague] = useState(!urlLeagueId);
  const [memberships, setMemberships] = useState<LeagueSummary[] | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const [season, setSeason] = useState("latest");
  const [seasons, setSeasons] = useState<string[]>([]);
  const [tab, setTab] = useState<"drivers" | "teams">("drivers");
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [leagueName, setLeagueName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leagueId = urlLeagueId; // once resolved, we redirect to the URL form so it stays shareable/bookmarkable

  useEffect(() => {
    if (urlLeagueId) return; // already have one, nothing to resolve

    let cancelled = false;
    setResolvingLeague(true);
    fetch("/api/pitboss/me/leagues")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        // Driver standings only make sense for racing leagues — a CFB
        // dynasty league has no driver championship to show, it'd just be
        // an error/empty state one tap deeper. Filter those out here so
        // the picker (and single-membership auto-redirect) only ever
        // offers leagues this page can actually render.
        const leagues: LeagueSummary[] = (data.leagues ?? []).filter(
          (l: LeagueSummary) => l.sport === "sim_racing"
        );
        if (leagues.length === 1) {
          // Only one membership — no ambiguity, just go straight there.
          router.replace(`/pitboss/standings?league_id=${leagues[0].league_id}`);
          return;
        }
        setMemberships(leagues);
      })
      .catch(() => {
        if (!cancelled) setMembershipError("Failed to load your leagues");
      })
      .finally(() => {
        if (!cancelled) setResolvingLeague(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlLeagueId]);

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
          setSeasons(data.seasons ?? []);
          setTeams(data.teams ?? []);
          // Resolve "latest" to the real season number the API picked.
          if (season === "latest" && data.season) setSeason(data.season);
        }
      })
      .catch(() => setError("Failed to load standings"))
      .finally(() => setLoading(false));
  }, [leagueId, season]);

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
        <button onClick={() => router.back()} className="text-neutral-400 text-sm mb-4">← Back</button>

        <h1 className="text-3xl font-bold mb-1">{leagueName || "Standings"}</h1>
        <p className="text-xs tracking-widest text-neutral-400 uppercase mb-6">
          {tab === "drivers" ? "Driver" : "Team"} Championship{season !== "latest" && season ? ` · Season ${season}` : ""}
        </p>

        {seasons.length > 1 && (
          <div className="flex gap-2 mb-6 overflow-x-auto">
            {seasons.map((s) => (
              <button
                key={s}
                onClick={() => setSeason(s)}
                className={`px-3 py-1 rounded-full text-xs border ${
                  s === season ? "bg-white text-black border-white" : "border-neutral-600 text-neutral-300"
                }`}
              >
                Season {s}
              </button>
            ))}
          </div>
        )}

        {urlLeagueId && (
          <div className="flex gap-2 mb-4">
            {(["drivers", "teams"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium border ${
                  tab === k ? "bg-white text-black border-white" : "border-neutral-600 text-neutral-300"
                }`}
              >
                {k === "drivers" ? "Drivers" : "Teams"}
              </button>
            ))}
          </div>
        )}

        {!urlLeagueId && resolvingLeague && (
          <p className="text-neutral-500 text-sm">Finding your league…</p>
        )}

        {membershipError && (
          <p className="text-red-500 text-sm">{membershipError}</p>
        )}

        {!urlLeagueId && !resolvingLeague && memberships && memberships.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-neutral-500 text-sm">
              You're not a member of any racing leagues yet — standings only apply to those.
            </p>
            <Link
              href="/leagues/join"
              className="rounded-full bg-rise-red px-5 py-2 text-sm font-semibold text-white transition active:scale-95"
            >
              + Join a League
            </Link>
          </div>
        )}

        {!urlLeagueId && !resolvingLeague && memberships && memberships.length > 1 && (
          <div className="flex flex-col gap-3">
            <p className="text-neutral-500 text-sm mb-1">Which league?</p>
            {memberships.map((league) => (
              <button
                key={league.league_id}
                onClick={() => router.push(`/pitboss/standings?league_id=${league.league_id}`)}
                className="rounded-2xl border border-neutral-800 bg-white/5 p-4 flex items-center gap-4 text-left active:scale-[0.98] transition-transform"
              >
                {league.logo_url ? (
                  <img
                    src={league.logo_url}
                    alt={league.name}
                    className="w-12 h-12 rounded-xl object-cover border border-neutral-800 flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-white/5 border border-neutral-800 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{league.name}</p>
                  <p className="text-xs text-neutral-500">{league.role.split(",")[0]?.trim()}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {tab === "teams" && teams.length === 0 && !loading && !error && urlLeagueId && (
          <p className="text-neutral-500 text-sm">No team standings yet.</p>
        )}

        {tab === "teams" && teams.length > 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
            {teams.map((row, i) => (
              <div
                key={row.franchise_id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i !== teams.length - 1 ? "border-b border-neutral-800" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-6 text-sm font-semibold ${row.position === 1 ? "text-red-500" : "text-neutral-400"}`}>
                    {row.position}
                  </span>
                  {row.logo_url ? (
                    <img src={row.logo_url} alt="" className="w-8 h-8 rounded-md object-cover" />
                  ) : (
                    <span
                      className="w-1.5 h-8 rounded-full"
                      style={{ backgroundColor: row.color ?? "#525252" }}
                    />
                  )}
                  <div>
                    <p className="font-medium">{row.team_name}</p>
                    <p className="text-xs text-neutral-500">
                      {row.wins} wins · {row.poles} poles · {row.fastest_laps} FL · {row.dnfs} DNF
                    </p>
                  </div>
                </div>
                <span className="text-lg font-bold">{row.points}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "drivers" && standings.length > 0 && (
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

export default function StandingsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <StandingsContent />
    </Suspense>
  );
}
