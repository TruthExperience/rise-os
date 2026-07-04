"use client";
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type League = {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  logo_url: string | null;
  season_count: number | null;
  isMember: boolean;
};

export default function JoinLeaguePage() {
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => setLeagues(data.leagues ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function join(league: League) {
    setJoiningId(league.id);
    setErrorId(null);

    const res = await fetch("/api/leagues/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueId: league.id }),
    });

    if (res.ok) {
      setLeagues((prev) =>
        prev.map((l) => (l.id === league.id ? { ...l, isMember: true } : l))
      );
      router.refresh();
    } else {
      setErrorId(league.id);
    }
    setJoiningId(null);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
        Join a league
      </h1>
      <p className="mt-1 text-sm text-neutral-400">
        Open leagues you can join right now. Ask a commissioner if the one
        you're looking for isn't listed yet.
      </p>

      {loading && (
        <p className="mt-8 text-sm text-neutral-500">Loading leagues…</p>
      )}

      {!loading && leagues.length === 0 && (
        <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/50 p-6 text-center">
          <p className="text-sm text-neutral-400">
            No leagues are open for self-service joining yet.
          </p>
        </div>
      )}

      <ul className="mt-8 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {leagues.map((league) => (
          <li
            key={league.id}
            className="flex items-center justify-between gap-4 p-4"
          >
            <div className="flex items-center gap-3">
              {league.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={league.logo_url}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <div className="h-10 w-10 rounded-full bg-neutral-800" />
              )}
              <div>
                <p className="font-medium text-neutral-100">{league.name}</p>
                <p className="text-xs text-neutral-500">
                  {league.sport ?? "CFB"} · Season {league.season_count ?? 1}
                </p>
              </div>
            </div>

            {league.isMember ? (
              <span className="rounded-full bg-emerald-900/40 px-3 py-1 text-xs font-medium text-emerald-400">
                Joined
              </span>
            ) : (
              <button
                onClick={() => join(league)}
                disabled={joiningId === league.id}
                className="rounded-full bg-neutral-100 px-4 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:opacity-50"
              >
                {joiningId === league.id ? "Joining…" : "Join"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {errorId && (
        <p className="mt-4 text-sm text-red-400">
          Couldn't join that league. It may not be open yet — try again later.
        </p>
      )}
    </div>
  );
}
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type League = {
  id: string;
  name: string;
  slug: string;
  sport: string | null;
  logo_url: string | null;
  season_count: number | null;
  isMember: boolean;
};

export default function JoinLeaguePage() {
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => setLeagues(data.leagues ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function join(league: League) {
    setJoiningId(league.id);
    setErrorId(null);

    const res = await fetch("/api/leagues/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueId: league.id }),
    });

    if (res.ok) {
      setLeagues((prev) =>
        prev.map((l) => (l.id === league.id ? { ...l, isMember: true } : l))
      );
      router.refresh();
    } else {
      setErrorId(league.id);
    }
    setJoiningId(null);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
        Join a league
      </h1>
      <p className="mt-1 text-sm text-neutral-400">
        Open leagues you can join right now. Ask a commissioner if the one
        you're looking for isn't listed yet.
      </p>

      {loading && (
        <p className="mt-8 text-sm text-neutral-500">Loading leagues…</p>
      )}

      {!loading && leagues.length === 0 && (
        <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/50 p-6 text-center">
          <p className="text-sm text-neutral-400">
            No leagues are open for self-service joining yet.
          </p>
        </div>
      )}

      <ul className="mt-8 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {leagues.map((league) => (
          <li
            key={league.id}
            className="flex items-center justify-between gap-4 p-4"
          >
            <div className="flex items-center gap-3">
              {league.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={league.logo_url}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <div className="h-10 w-10 rounded-full bg-neutral-800" />
              )}
              <div>
                <p className="font-medium text-neutral-100">{league.name}</p>
                <p className="text-xs text-neutral-500">
                  {league.sport ?? "CFB"} · Season {league.season_count ?? 1}
                </p>
              </div>
            </div>

            {league.isMember ? (
              <span className="rounded-full bg-emerald-900/40 px-3 py-1 text-xs font-medium text-emerald-400">
                Joined
              </span>
            ) : (
              <button
                onClick={() => join(league)}
                disabled={joiningId === league.id}
                className="rounded-full bg-neutral-100 px-4 py-1.5 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:opacity-50"
              >
                {joiningId === league.id ? "Joining…" : "Join"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {errorId && (
        <p className="mt-4 text-sm text-red-400">
          Couldn't join that league. It may not be open yet — try again later.
        </p>
      )}
    </div>
  );
}
