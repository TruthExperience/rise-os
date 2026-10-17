// FILE: src/app/pitboss/results/page.tsx   (replace the whole file)
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RESULTS_CHANNEL } from "@/lib/standings-sync";

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

const POLL_MS = 8000;

function ResultsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const leagueId = searchParams.get("league_id");
  const season = searchParams.get("season") ?? ""; // "" = latest season with results
  const round = searchParams.get("round") ?? ""; // "" = all races

  const [activeSeason, setActiveSeason] = useState("");
  const [seasons, setSeasons] = useState<string[]>([]);
  const [rounds, setRounds] = useState<{ round: number; track: string | null }[]>([]);
  const [leagueName, setLeagueName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKey = useRef("");

  const go = useCallback(
    (next: { season?: string; round?: string }) => {
      const p = new URLSearchParams();
      if (leagueId) p.set("league_id", leagueId);
      const s = next.season ?? season;
      const r = next.round ?? round;
      if (s) p.set("season", s);
      if (r) p.set("round", r);
      router.replace(`/pitboss/results?${p.toString()}`);
    },
    [leagueId, season, round, router]
  );

  const load = useCallback(
    async (silent = false) => {
      if (!leagueId) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const params = new URLSearchParams({ league_id: leagueId });
      if (season) params.set("season", season);
      if (round) params.set("round", round);
      try {
        const res = await fetch(`/api/pitboss/results?${params}`, { cache: "no-store" });
        const data = await res.json();
        if (data.error) {
          if (!silent) {
            setError(data.error);
            setResults([]);
          }
          return;
        }
        const key = JSON.stringify([data.season, data.rounds, data.results?.map((r: any) => [r.id, r.finish_position, r.points_earned, r.sprint_points_earned, r.dnf])]);
        if (silent && key === lastKey.current) return;
        lastKey.current = key;
        setLeagueName(data.league_name);
        setLogoUrl(data.league_logo_url);
        setActiveSeason(data.season ?? "");
        setSeasons(data.seasons ?? []);
        setRounds(data.rounds ?? []);
        setResults(data.results);
      } catch {
        if (!silent) setError("Failed to load results");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [leagueId, season, round]
  );

  useEffect(() => {
    lastKey.current = "";
    load(false);
  }, [load]);

  // Instant sync: poll while visible, refresh on focus, and on steward saves.
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

  // With "All races" selected, group rows under a header per round.
  const groups = new Map<number, ResultRow[]>();
  for (const r of results) {
    if (!groups.has(r.round)) groups.set(r.round, []);
    groups.get(r.round)!.push(r);
  }
  const orderedRounds = [...groups.keys()].sort((a, b) => a - b);
  const trackFor = (n: number) => rounds.find((x) => x.round === n)?.track ?? null;

  return (
    <div className="relative min-h-screen bg-black text-white">
      {logoUrl && (
        <div className="fixed inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${logoUrl})` }}>
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
          <h1 className="text-3xl font-bold">{leagueName || "Results"}</h1>
        </div>
        <p className="text-xs tracking-widest text-neutral-400 uppercase mb-4 flex items-center gap-2">
          Race Results{activeSeason ? ` · Season ${activeSeason}` : ""}
          {round ? ` · Round ${round}` : ""}
          {leagueId && (
            <span className="inline-flex items-center gap-1 text-green-400 normal-case tracking-normal">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
        </p>

        {leagueId && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {seasons.length > 0 && (
              <select
                value={activeSeason}
                onChange={(e) => go({ season: e.target.value, round: "" })}
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
                value={round}
                onChange={(e) => go({ round: e.target.value })}
                className="rounded-full border border-neutral-800 bg-black/60 px-3 py-1.5 text-sm text-white max-w-[12rem]"
                aria-label="Race"
              >
                <option value="">All races</option>
                {rounds.map((r) => (
                  <option key={r.round} value={r.round}>
                    R{r.round}{r.track ? ` · ${r.track}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {!leagueId && (
          <p className="text-neutral-500 text-sm">
            No league selected — this page expects a <code>?league_id=</code> query param.
          </p>
        )}

        {loading && <p className="text-neutral-500 text-sm">Loading…</p>}
        {error && <p className="text-red-500 text-sm">{error}</p>}
        {leagueId && !loading && !error && results.length === 0 && (
          <p className="text-neutral-500 text-sm">No results yet.</p>
        )}

        {orderedRounds.map((n) => {
          const rows = groups.get(n)!;
          return (
            <div key={n} className="mb-5">
              {!round && (
                <h2 className="mb-2 text-sm font-semibold text-neutral-300">
                  Round {n}{trackFor(n) ? ` · ${trackFor(n)}` : ""}
                </h2>
              )}
              <div className="rounded-2xl border border-neutral-800 bg-black/40 backdrop-blur-sm overflow-hidden">
                {rows.map((r, i) => (
                  <div
                    key={r.id}
                    className={`flex items-center justify-between px-4 py-3 ${
                      i !== rows.length - 1 ? "border-b border-neutral-800" : ""
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-8 text-sm font-semibold ${r.finish_position === 1 ? "text-red-500" : "text-neutral-400"}`}>
                        {r.dnf ? "DNF" : r.finish_position ?? "—"}
                      </span>
                      <div>
                        <p className="font-medium">
                          {r.driver?.display_name ?? r.driver?.discord_username ?? "Unknown"}
                        </p>
                        <p className="text-xs text-neutral-500">
                          {r.qualifying_position ? `Q${r.qualifying_position}` : "No quali"}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <ResultsContent />
    </Suspense>
  );
}
