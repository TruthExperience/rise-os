"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { findCfbTeam, CfbTeam } from "@/lib/matchCfbTeam";

type Player = {
  id: string;
  name: string;
  position: string | null;
  status: string | null;
  ovr: number | null;
  jersey_number: number | null;
  class_year: string | null;
  dev_trait: string | null;
  seasons_played: number | null;
};

export default function FranchiseDetailPage() {
  const { status } = useSession();
  const router = useRouter();
  const { leagueId, franchiseId } = useParams<{ leagueId: string; franchiseId: string }>();
  const [franchise, setFranchise] = useState<any>(null);
  const [cfbTeams, setCfbTeams] = useState<CfbTeam[]>([]);
  const [roster, setRoster] = useState<Player[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (franchiseId) {
      fetchFranchise();
      fetchRoster();
    }
    fetchCfbTeams();
  }, [franchiseId]);

  async function fetchFranchise() {
    setLoading(true);
    try {
      const res = await fetch(`/api/franchises/${leagueId}/${franchiseId}`);
      if (res.ok) setFranchise(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchRoster() {
    setRosterLoading(true);
    try {
      const res = await fetch(`/api/franchises/${leagueId}/${franchiseId}/roster`);
      if (res.ok) setRoster(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setRosterLoading(false);
    }
  }

  async function fetchCfbTeams() {
    try {
      const res = await fetch("/api/cfb-teams");
      if (res.ok) setCfbTeams(await res.json());
    } catch (e) {
      console.error(e);
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/franchises/${leagueId}/${franchiseId}`, {
        method: "PUT",
        body: formData,
      });
      if (res.ok) {
        const updated = await res.json();
        setFranchise((prev: any) => ({ ...prev, logo_url: updated.logo_url }));
      } else {
        const body = await res.json().catch(() => null);
        setUploadError(body?.error ?? "Upload failed. Please try again.");
      }
    } catch (e) {
      console.error(e);
      setUploadError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  if (status === "loading" || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
      </main>
    );
  }

  if (!franchise) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <p className="text-white/40">Franchise not found.</p>
      </main>
    );
  }

  const cfbTeam = findCfbTeam(franchise.name, cfbTeams);

  const hasLifetimeRecord =
    franchise.irl_lifetime_wins !== null && franchise.irl_lifetime_wins !== undefined &&
    franchise.irl_lifetime_losses !== null && franchise.irl_lifetime_losses !== undefined;

  const lifetimeTies = franchise.irl_lifetime_ties ?? 0;
  const lifetimeRecordText = hasLifetimeRecord
    ? lifetimeTies > 0
      ? `${franchise.irl_lifetime_wins}-${franchise.irl_lifetime_losses}-${lifetimeTies}`
      : `${franchise.irl_lifetime_wins}-${franchise.irl_lifetime_losses}`
    : null;

  const lifetimeWinPct =
    franchise.irl_win_pct !== null && franchise.irl_win_pct !== undefined
      ? `${(franchise.irl_win_pct * 100).toFixed(1)}%`
      : null;

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button onClick={() => router.back()} className="flex items-center gap-2 text-white/40 text-sm mb-6">
        ← Back
      </button>

      <div className="flex flex-col items-center mb-8">
        <button onClick={() => fileRef.current?.click()} className="relative mb-4 group" disabled={uploading}>
          {franchise.logo_url ? (
            <img src={franchise.logo_url} alt={franchise.name}
              className="w-24 h-24 rounded-2xl object-cover border border-white/10" />
          ) : (
            <div className="w-24 h-24 rounded-2xl border border-white/10 flex items-center justify-center"
              style={{ backgroundColor: franchise.primary_color ?? "#ffffff20" }}>
              <span className="text-white font-black text-2xl">
                {franchise.abbreviation ?? franchise.name.slice(0, 3).toUpperCase()}
              </span>
            </div>
          )}
          <div className="absolute inset-0 rounded-2xl bg-black/50 flex items-center justify-center opacity-0 group-active:opacity-100 transition-opacity">
            <span className="text-white text-xs font-bold">{uploading ? "Uploading..." : "Change"}</span>
          </div>
        </button>

        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden" onChange={handleLogoUpload} />

        {uploadError && (
          <p className="text-rise-red text-xs mb-2">{uploadError}</p>
        )}

        <h1 className="text-2xl font-black text-white text-center">{franchise.name}</h1>
        {franchise.abbreviation && (
          <p className="text-white/30 text-xs uppercase tracking-widest mt-1">{franchise.abbreviation}</p>
        )}
        {cfbTeam?.conference && (
          <p className="text-white/30 text-xs mt-1">{cfbTeam.conference}</p>
        )}
      </div>

      <div className="flex gap-3 mb-6 justify-center">
        {franchise.primary_color && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full border border-white/20" style={{ backgroundColor: franchise.primary_color }} />
            <span className="text-white/40 text-xs">{franchise.primary_color}</span>
          </div>
        )}
        {franchise.secondary_color && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full border border-white/20" style={{ backgroundColor: franchise.secondary_color }} />
            <span className="text-white/40 text-xs">{franchise.secondary_color}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-black text-white">{franchise.wins ?? 0}</p>
            <p className="text-white/30 text-xs uppercase tracking-wide mt-1">Wins</p>
          </div>
          <div>
            <p className="text-2xl font-black text-white">{franchise.losses ?? 0}</p>
            <p className="text-white/30 text-xs uppercase tracking-wide mt-1">Losses</p>
          </div>
          <div>
            <p className="text-2xl font-black text-white">{franchise.championships ?? 0}</p>
            <p className="text-white/30 text-xs uppercase tracking-wide mt-1">Titles</p>
          </div>
        </div>

        {hasLifetimeRecord && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-white/30 text-xs uppercase tracking-widest mb-4 text-center">
              Lifetime Record
            </p>
            <div className="flex items-baseline justify-center gap-3">
              <span className="text-2xl font-black text-white">{lifetimeRecordText}</span>
              {lifetimeWinPct && (
                <span className="text-white/40 text-xs">{lifetimeWinPct} win pct</span>
              )}
            </div>
            {franchise.irl_record_source && (
              <p className="text-white/20 text-[10px] text-center mt-2 uppercase tracking-widest">
                Source: {franchise.irl_record_source}
              </p>
            )}
          </div>
        )}

        {cfbTeam && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-white/30 text-xs uppercase tracking-widest mb-4 text-center">
              CFB27 Team Rating
            </p>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-black text-white">{cfbTeam.ovr ?? "—"}</p>
                <p className="text-white/30 text-xs uppercase tracking-wide mt-1">OVR</p>
              </div>
              <div>
                <p className="text-2xl font-black text-white">{cfbTeam.offense_ovr ?? "—"}</p>
                <p className="text-white/30 text-xs uppercase tracking-wide mt-1">Offense</p>
              </div>
              <div>
                <p className="text-2xl font-black text-white">{cfbTeam.defense_ovr ?? "—"}</p>
                <p className="text-white/30 text-xs uppercase tracking-wide mt-1">Defense</p>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <p className="text-white/30 text-xs uppercase tracking-widest mb-4">
            Roster {roster.length > 0 && `(${roster.length})`}
          </p>

          {rosterLoading ? (
            <div className="flex justify-center py-6">
              <div className="h-6 w-6 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
            </div>
          ) : roster.length === 0 ? (
            <p className="text-white/30 text-sm text-center py-6">No players on this roster yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {roster.map((p) => (
                <div key={p.id} className="flex items-center justify-between border-b border-white/5 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-white/30 text-xs font-mono w-6 text-right flex-shrink-0">
                      {p.jersey_number ?? "—"}
                    </span>
                    <div className="min-w-0">
                      <p className="text-white text-sm font-semibold truncate">{p.name}</p>
                      <p className="text-white/30 text-xs">
                        {p.position ?? "—"}
                        {p.class_year ? ` · ${p.class_year}` : ""}
                        {p.status && p.status !== "active" ? ` · ${p.status}` : ""}
                      </p>
                    </div>
                  </div>
                  {p.ovr != null && (
                    <span className="text-white font-black text-sm flex-shrink-0 ml-2">{p.ovr}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
