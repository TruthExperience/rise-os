"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";

interface Franchise {
  id: string;
  name: string;
  abbreviation: string;
  logo_url: string | null;
  wins: number;
  losses: number;
}

interface Game {
  id: string;
  season_id: string;
  week: number;
  home_franchise_id: string;
  away_franchise_id: string;
  home_score: number | null;
  away_score: number | null;
  played_at: string | null;
  home_franchise: Franchise | null;
  away_franchise: Franchise | null;
}

export default function LeagueGamesPage() {
  const { status } = useSession();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [games, setGames] = useState<Game[]>([]);
  const [standings, setStandings] = useState<Franchise[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingGameId, setEditingGameId] = useState<string | null>(null);
  const [editHome, setEditHome] = useState<string>("");
  const [editAway, setEditAway] = useState<string>("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status === "authenticated" && id) fetchGames();
  }, [status, id]);

  async function fetchGames() {
    setLoading(true);
    try {
      const res = await fetch(`/api/league/${id}/games`);
      if (res.ok) {
        const data = await res.json();
        setGames(data.games ?? []);
        setStandings(data.standings ?? []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  function startEdit(game: Game) {
    setEditingGameId(game.id);
    setEditHome(game.home_score?.toString() ?? "");
    setEditAway(game.away_score?.toString() ?? "");
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingGameId(null);
    setSaveError(null);
  }

  async function saveScore(gameId: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/league/${id}/games`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: gameId,
          home_score: editHome === "" ? null : parseInt(editHome),
          away_score: editAway === "" ? null : parseInt(editAway),
        }),
      });

      if (res.status === 403) {
        setSaveError("You don't have permission to edit games in this league.");
        setSaving(false);
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error ?? "Failed to save score.");
        setSaving(false);
        return;
      }

      await fetchGames();
      setEditingGameId(null);
    } catch (e) {
      setSaveError("Network error — try again");
    } finally {
      setSaving(false);
    }
  }

  const gamesByWeek = games.reduce<Record<number, Game[]>>((acc, g) => {
    (acc[g.week] ??= []).push(g);
    return acc;
  }, {});
  const weeks = Object.keys(gamesByWeek)
    .map(Number)
    .sort((a, b) => a - b);

  if (status === "loading" || loading) {
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

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-white">Games</h1>
          <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
            Schedule & Standings
          </p>
        </div>
      </div>

      <button
        onClick={() => router.push(`/league/${id}/games/bulk`)}
        className="text-white/30 text-xs mb-6"
      >
        + Bulk Add Games
      </button>

      {/* Standings */}
      {standings.length > 0 && (
        <div className="mb-8">
          <p className="text-xs text-white/40 uppercase tracking-widest mb-3">Standings</p>
          <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
            {standings.map((f, i) => (
              <div
                key={f.id}
                className={`flex items-center gap-3 px-4 py-3 ${
                  i !== standings.length - 1 ? "border-b border-white/5" : ""
                }`}
              >
                <span className="text-white/20 text-xs w-4">{i + 1}</span>
                {f.logo_url ? (
                  <img
                    src={f.logo_url}
                    alt={f.name}
                    className="w-8 h-8 rounded-lg object-cover border border-white/10"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-xs text-white/30">
                    {f.abbreviation}
                  </div>
                )}
                <span className="flex-1 text-white text-sm font-semibold truncate">
                  {f.name}
                </span>
                <span className="text-white/40 text-xs font-bold">
                  {f.wins ?? 0}-{f.losses ?? 0}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Games by week */}
      {weeks.length === 0 ? (
        <p className="text-white/20 text-sm">No games scheduled yet.</p>
      ) : (
        weeks.map((week) => (
          <div key={week} className="mb-6">
            <p className="text-xs text-white/40 uppercase tracking-widest mb-3">
              Week {week}
            </p>
            <div className="flex flex-col gap-3">
              {gamesByWeek[week].map((game) => {
                const isEditing = editingGameId === game.id;
                return (
                  <div
                    key={game.id}
                    className="rounded-2xl border border-white/10 bg-white/5 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <TeamRow
                        franchise={game.away_franchise}
                        score={game.away_score}
                        editing={isEditing}
                        editValue={editAway}
                        onEditChange={setEditAway}
                      />
                      <span className="text-white/20 text-xs">@</span>
                      <TeamRow
                        franchise={game.home_franchise}
                        score={game.home_score}
                        editing={isEditing}
                        editValue={editHome}
                        onEditChange={setEditHome}
                      />
                    </div>

                    {saveError && isEditing && (
                      <p className="text-rise-red text-xs mt-3">{saveError}</p>
                    )}

                    <div className="flex justify-end gap-2 mt-3">
                      {isEditing ? (
                        <>
                          <button
                            onClick={cancelEdit}
                            className="rounded-lg px-3 py-1.5 text-xs font-bold text-white/40"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => saveScore(game.id)}
                            disabled={saving}
                            className="rounded-lg bg-rise-red px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
                          >
                            {saving ? "Saving..." : "Save"}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => startEdit(game)}
                          className="text-white/30 text-xs"
                        >
                          ✏️ Edit Score
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </main>
  );
}

function TeamRow({
  franchise,
  score,
  editing,
  editValue,
  onEditChange,
}: {
  franchise: Franchise | null;
  score: number | null;
  editing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      {franchise?.logo_url ? (
        <img
          src={franchise.logo_url}
          alt={franchise.name}
          className="w-8 h-8 rounded-lg object-cover border border-white/10 flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-[10px] text-white/30 flex-shrink-0">
          {franchise?.abbreviation ?? "?"}
        </div>
      )}
      <span className="text-white text-sm font-semibold truncate">
        {franchise?.abbreviation ?? "TBD"}
      </span>
      {editing ? (
        <input
          type="number"
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          className="w-14 rounded-lg bg-white/10 border border-white/20 px-2 py-1 text-white text-sm text-center focus:outline-none focus:border-rise-red"
        />
      ) : (
        <span className="text-white/60 text-sm font-bold ml-auto">
          {score ?? "-"}
        </span>
      )}
    </div>
  );
}
