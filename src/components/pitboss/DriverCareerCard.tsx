"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

type Franchise = {
  id: string;
  name: string;
  abbreviation: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  race_starts: number | null;
  race_wins: number | null;
  race_top3: number | null;
  race_top5: number | null;
  race_top10: number | null;
};

type Stats = {
  starts: number;
  wins: number;
  top3: number;
  top5: number;
  top10: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  points: number;
};

type TeamBlock = {
  franchiseId: string | null;
  franchise: Franchise | null;
  seasonRange: string | null;
  stats: Stats;
};

type CareerResponse = {
  driverId: string;
  career: Stats;
  teams: TeamBlock[];
};

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center px-3">
      <span className="text-2xl font-bold text-white leading-tight">{value}</span>
      <span className="text-xs uppercase tracking-wide text-gray-400">{label}</span>
    </div>
  );
}

function TeamCard({ team }: { team: TeamBlock }) {
  const [open, setOpen] = useState(false);
  const accent = team.franchise?.primary_color || "#E8284A";

  return (
    <div
      className="relative rounded-xl bg-[#12151c] overflow-hidden"
      style={{ borderLeft: `4px solid ${accent}` }}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="w-14 h-14 rounded-lg bg-[#1e2330] flex items-center justify-center overflow-hidden shrink-0">
          {team.franchise?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={team.franchise.logo_url}
              alt={team.franchise.name}
              className="w-full h-full object-contain"
            />
          ) : (
            <span className="text-gray-500 text-xl font-bold">
              {team.franchise?.abbreviation?.[0] ?? "?"}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-white font-bold text-lg truncate">
            {team.franchise?.name ?? "Unassigned"}
          </h3>
          {team.franchise?.abbreviation && (
            <p className="text-sm font-medium" style={{ color: accent }}>
              {team.franchise.abbreviation}
            </p>
          )}
          {team.seasonRange && (
            <p className="text-sm text-gray-400">{team.seasonRange}</p>
          )}
        </div>
      </div>

      <div className="flex justify-between px-4 pb-3">
        <StatPill label="Starts" value={team.stats.starts} />
        <StatPill label="Wins" value={team.stats.wins} />
        <StatPill label="Top 3" value={team.stats.top3} />
        <StatPill label="Top 5" value={team.stats.top5} />
        <StatPill label="Top 10" value={team.stats.top10} />
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 border-t border-white/5 text-gray-300 text-sm"
      >
        <span>Detailed Stats</span>
        <ChevronDown
          size={18}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          <div className="grid grid-cols-2 gap-y-2 text-sm text-gray-300">
            <span>Poles</span>
            <span className="text-right text-white">{team.stats.poles}</span>
            <span>Fastest Laps</span>
            <span className="text-right text-white">{team.stats.fastestLaps}</span>
            <span>DNFs</span>
            <span className="text-right text-white">{team.stats.dnfs}</span>
            <span>Points</span>
            <span className="text-right text-white">{team.stats.points}</span>
          </div>

          {team.franchise && team.franchise.race_starts != null && (
            <div className="pt-3 border-t border-white/5">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                {team.franchise.name} — All-Time Team Record
              </p>
              <div className="flex justify-between">
                <StatPill label="Starts" value={team.franchise.race_starts ?? 0} />
                <StatPill label="Wins" value={team.franchise.race_wins ?? 0} />
                <StatPill label="Top 3" value={team.franchise.race_top3 ?? 0} />
                <StatPill label="Top 5" value={team.franchise.race_top5 ?? 0} />
                <StatPill label="Top 10" value={team.franchise.race_top10 ?? 0} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DriverCareerCard({ driverId }: { driverId: string }) {
  const [data, setData] = useState<CareerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/pitboss/drivers/${driverId}/career`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  if (loading) {
    return <div className="text-gray-400 text-sm py-6 text-center">Loading career stats…</div>;
  }
  if (error) {
    return <div className="text-red-400 text-sm py-6 text-center">Couldn't load career stats.</div>;
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
          Career
        </h2>
        <div className="rounded-xl bg-[#12151c] border-l-4 border-[#E8284A] flex justify-between px-2 py-4">
          <StatPill label="Starts" value={data.career.starts} />
          <StatPill label="Wins" value={data.career.wins} />
          <StatPill label="Top 3" value={data.career.top3} />
          <StatPill label="Top 5" value={data.career.top5} />
          <StatPill label="Top 10" value={data.career.top10} />
        </div>
      </div>

      <div>
        <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
          Teams Driven For
        </h2>
        {data.teams.length === 0 ? (
          <p className="text-gray-500 text-sm">No results recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {data.teams.map((team) => (
              <TeamCard key={team.franchiseId ?? "unassigned"} team={team} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
