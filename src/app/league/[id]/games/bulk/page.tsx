"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";

interface Franchise {
  id: string;
  name: string;
  abbreviation: string;
}

interface Row {
  week: string;
  home: string;
  away: string;
  homeScore: string;
  awayScore: string;
}

export default function BulkGamesPage() {
  const { status } = useSession();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [franchises, setFranchises] = useState<Franchise[]>([]);
  const [rows, setRows] = useState<Row[]>([
    { week: "", home: "", away: "", homeScore: "", awayScore: "" },
  ]);
  const [loadingFranchises, setLoadingFranchises] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useState(() => {
    fetch(`/api/league/${id}/games`)
      .then((r) => r.json())
      .then((data) => setFranchises(data.standings ?? []))
      .catch(() => {})
      .finally(() => setLoadingFranchises(false));
  });

  function updateRow(i: number, field: keyof Row, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { week: "", home: "", away: "", homeScore: "", awayScore: "" },
    ]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setError(null);
    setSuccess(null);

    const validRows = rows.filter((r) => r.week && r.home && r.away);
    if (validRows.length === 0) {
      setError("Add at least one row with week, home, and away teams.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/league/${id}/games`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: validRows.map((r) => ({
            season_id: null,
            week: parseInt(r.week),
            home_franchise_id: r.home,
            away_franchise_id: r.away,
            home_score: r.homeScore === "" ? null : parseInt(r.homeScore),
            away_score: r.awayScore === "" ? null : parseInt(r.awayScore),
          })),
        }),
      });

      if (res.status === 403) {
        setError("You don't have permission to add games in this league.");
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to save games.");
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      setSuccess(`Added ${data.games?.length ?? validRows.length} games.`);
      setRows([{ week: "", home: "", away: "", homeScore: "", awayScore: "" }]);
    } catch {
      setError("Network error — try again");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading" || loadingFranchises) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      <div className="mb-6">
        <h1 className="text-2xl font-black text-white">Bulk Add Games</h1>
        <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
          Enter results, one row per game
        </p>
      </div>

      {franchises.length === 0 && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-xs text-rise-red">
            No franchises found for this league yet — add teams before entering games.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 mb-4">
        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-2xl border border-white/10 bg-white/5 p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/30 uppercase tracking-widest">
                Game {i + 1}
              </span>
              {rows.length > 1 && (
                <button
                  onClick={() => removeRow(i)}
                  className="text-white/30 text-xs"
                >
                  ✕ Remove
                </button>
              )}
            </div>

            <input
              type="number"
              placeholder="Week"
              value={row.week}
              onChange={(e) => updateRow(i, "week", e.target.value)}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
            />

            <div className="grid grid-cols-2 gap-2">
              <select
                value={row.away}
                onChange={(e) => updateRow(i, "away", e.target.value)}
                className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-white text-sm focus:outline-none focus:border-rise-red"
              >
                <option value="" className="bg-[#1A1A1A]">Away Team</option>
                {franchises.map((f) => (
                  <option key={f.id} value={f.id} className="bg-[#1A1A1A]">
                    {f.abbreviation} — {f.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Away Score"
                value={row.awayScore}
                onChange={(e) => updateRow(i, "awayScore", e.target.value)}
                className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={row.home}
                onChange={(e) => updateRow(i, "home", e.target.value)}
                className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-white text-sm focus:outline-none focus:border-rise-red"
              >
                <option value="" className="bg-[#1A1A1A]">Home Team</option>
                {franchises.map((f) => (
                  <option key={f.id} value={f.id} className="bg-[#1A1A1A]">
                    {f.abbreviation} — {f.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Home Score"
                value={row.homeScore}
                onChange={(e) => updateRow(i, "homeScore", e.target.value)}
                className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-white placeholder-white/20 text-sm focus:outline-none focus:border-rise-red"
              />
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={addRow}
        className="w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-bold text-white/60 mb-4"
      >
        + Add Another Game
      </button>

      {error && (
        <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
          <p className="text-xs text-rise-red">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
          <p className="text-xs text-green-400">✅ {success}</p>
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting || franchises.length === 0}
        className="w-full rounded-xl bg-rise-red py-3 text-sm font-bold text-white disabled:opacity-40"
      >
        {submitting ? "Saving..." : "Save Games"}
      </button>
    </main>
  );
}
