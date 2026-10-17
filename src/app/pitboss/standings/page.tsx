"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { RESULTS_CHANNEL } from "@/lib/standings-sync";

type View = "drivers" | "teams";

interface DriverRow {
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
  drivers: number;
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

const POLL_MS = 8000;

function StandingsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlLeagueId = searchParams.get("league_id");
  const urlSeason = searchParams.get("season");
  const urlRound = searchParams.get("round");
  const view: View = searchParams.get("view") === "teams" ? "teams" : "drivers";

  const [resolvingLeague, setResolvingLeague] = useState(!urlLeagueId);
  const [memberships, setMemberships] = useState<LeagueSummary[] | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const [season, setSeason] = useState<string | null>(urlSeason);
  const [seasons, setSeasons] = useState<string[]>([]);
  const [rounds, setRounds] = useState<{ round: number; track: string | null }[]>([]);
  const [leagueName, setLeagueName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const leagueId = urlLeagueId;
  const versionRef = useRef<string>("");

  // Keep view/season in the URL so the page stays shareable/bookmarkable.
  const buildUrl = useCallback(
    (next: { view?: View; season?: string | null; round?: string | null }) => {
      const p = new URLSearchParams();
      if (leagueId) p.set("league_id", leagueId);
      const s = next.season === undefined ? season : next.season;
      if (s) p.set("season", s);
      const r = next.round === undefined ? urlRound : next.round;
      if (r) p.set("round", r);
      p.set("view", next.view ?? view);
      return `/pitboss/standings?${p.toString()}`;
    },
    [leagueId, season, view, urlRound]
  );

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

  // Fetch (or silently re-fetch) standings. Silent refreshes don't flash the
  // loading state, and rows only re-render when the server's version changes.
  const load = useCallback(
    async (silent = false) => {
      if (!leagueId) return;
      if (!silent) setLoading(true);
      try {
        const qs = new URLSearchParams({ league_id: leagueId, view });
        if (season) qs.set("season", season);
        if (urlRound) qs.set("round", urlRound);
        const res = await fetch(`/api/pitboss/standings?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (data.error) {
          setError(data.error);
          if (!silent) {
            setDrivers([]);
            setTeams([]);
          }
          return;
        }
        setError(null);
        setLeagueName(data.league_name);
        setLogoUrl(data.league_logo_url);
        setSeasons(data.seasons ?? []);
        setRounds(data.rounds ?? []);
        if (!season && data.season) setSeason(data.season);

        const key = `${view}:${data.season}:${urlRound ?? ""}:${data.version}`;
        if (silent && key === versionRef.current) return; // nothing changed
        versionRef.current = key;
        if (view === "teams") setTeams(data.standings);
        else setDrivers(data.standings);
        setUpdatedAt(new Date());
      } catch {
        if (!silent) setError("Failed to load standings");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [leagueId, season, view, urlRound]
  );

  // Initial load + reload when league/season/view changes.
  useEffect(() => {
    versionRef.current = "";
    load(false);
  }, [load]);

  // Instant sync: poll while visible, refresh on focus/visibility, and refresh
  // immediately when a steward saves results in another tab of this browser.
  useEffect(() => {
    if (!leagueId) return;
    const tick = () => {
      if (document.visibilityState === "visible") load(true);
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(RESULTS_CHANNEL);
      bc.onmessage = () => load(true);
    } catch {
      /* unsupported */
    }

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      bc?.close();
    };
  }, [leagueId, load]);

  const rows = view === "teams" ? teams : drivers;

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

        <div className="flex items-center gap-3 mb-1">
          {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-14 w-14 rounded-full object-cover shrink-0" />
        )}
          <h1 className="text-3xl font-bold">{leagueName || "Standings"}</h1>
        </div>
        <p className="text-xs tracking-widest text-neutral-400 uppercase mb-4 flex items-center gap-2">
          {view === "teams" ? "Team Championship" : "Driver Championship"}
          {season ? ` · Season ${season}` : ""}
          {urlRound ? ` · After Round ${urlRound}` : ""}
          {leagueId && (
            <span className="inline-flex items-center gap-1 text-green-400 normal-case tracking-normal">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
        </p>

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

        {leagueId && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div
              role="tablist"
              aria-label="Standings type"
              className="inline-flex rounded-full border border-neutral-800 bg-white/5 p-1"
            >
              {(["drivers", "teams"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => router.replace(buildUrl({ view: v }))}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                    view === v ? "bg-rise-red text-white" : "text-neutral-400"
                  }`}
                >
                  {v === "drivers" ? "Drivers" : "Teams"}
                </button>
              ))}
            </div>

            {seasons.length > 0 && (
              <select
                value={season ?? ""}
                onChange={(e) => {
                  setSeason(e.target.value);
                  router.replace(buildUrl({ season: e.target.value, round: null }));
                }}
                className="rounded-full border border-neutral-800 bg-black/60 px-3 py-1.5 text-sm text-white"
                aria-label="Season"
              >
                {seasons.map((s) => (
                  <option key={s} value={s}>Season {s}</option>
                ))}
              </select>
            )}

            {rounds.length > 0 && (
              <select
                value={urlRound ?? ""}
                onChange={(e) => router.replace(buildUrl({ round: e.target.value || null }))}
                className="rounded-full border border-neutral-800 bg-black/60 px-3 py-1.5 text-sm text-white max-w-[11rem]"
                aria-label="Standings after race"
              >
                <option value="">Latest</option>
                {rounds.map((r) => (
                  <option key={r.round} value={r.round}>
                    After R{r.round}{r.track ? ` · ${r.track}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}

        {leagueId && !loading && !error && rows.length === 0 && (
          <p className="text-neutral-500 text-sm">
            {view === "teams"
              ? "No team results yet — team points appear once results carry a team."
              : "No results recorded yet."}
          </p>
        )}

        {view === "drivers" && drivers.length > 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
            {drivers.map((row, i) => (
              <div
                key={row.driver_id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i !== drivers.length - 1 ? "border-b border-neutral-800" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-6 text-sm font-semibold ${row.position === 1 ? "text-red-500" : "text-neutral-400"}`}>
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

        {view === "teams" && teams.length > 0 && (
          <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
            {teams.map((row, i) => (
              <div
                key={row.franchise_id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i !== teams.length - 1 ? "border-b border-neutral-800" : ""
                }`}
                style={row.color ? { borderLeft: `3px solid ${row.color}` } : undefined}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-6 text-sm font-semibold ${row.position === 1 ? "text-red-500" : "text-neutral-400"}`}>
                    {row.position}
                  </span>
                  {row.logo_url && (
                    <img src={row.logo_url} alt="" className="h-8 w-8 rounded-lg object-cover flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{row.team_name}</p>
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

        {updatedAt && (
          <p className="mt-3 text-[11px] text-neutral-600">
            Updated {updatedAt.toLocaleTimeString()} · refreshes automatically
          </p>
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
