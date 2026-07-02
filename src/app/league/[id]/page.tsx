"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const SPORT_LABELS: Record<string, string> = {
  cfb: "College Football",
  nfl: "NFL",
  nba: "NBA",
  soccer: "Soccer",
  nhl: "NHL",
  sim_racing: "Sim Racing",
  other: "Other",
};

const SPORT_EMOJI: Record<string, string> = {
  cfb: "🏈",
  nfl: "🏈",
  nba: "🏀",
  soccer: "⚽",
  nhl: "🏒",
  sim_racing: "🏎️",
  other: "🏆",
};

// Pitboss (Certification, Incidents, Stewards) is a sim-racing-specific
// module — only show those tiles for leagues in that sport.
const PITBOSS_SPORTS = new Set(["sim_racing"]);

export default function LeagueDetailPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [league, setLeague] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [canSeeStewards, setCanSeeStewards] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (id) fetchLeague();
  }, [id]);

  useEffect(() => {
    if (id && session?.user) checkStewardAccess();
  }, [id, session]);

  async function fetchLeague() {
    setLoading(true);
    try {
      const res = await fetch(`/api/leagues/${id}`);
      if (res.ok) setLeague(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function checkStewardAccess() {
    try {
      const res = await fetch(`/api/leagues/${id}/steward-access`);
      if (res.ok) {
        const { hasAccess } = await res.json();
        setCanSeeStewards(hasAccess);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/leagues/${id}`, {
        method: "PUT",
        body: formData,
      });
      if (res.ok) {
        const updated = await res.json();
        setLeague((prev: any) => ({ ...prev, logo_url: updated.logo_url }));
      }
    } catch (e) {
      console.error(e);
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

  if (!league) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-rise-black">
        <p className="text-white/40">League not found.</p>
      </main>
    );
  }

  const showPitboss = PITBOSS_SPORTS.has(league.sport);

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-white/40 text-sm mb-6"
      >
        ← Back
      </button>

      {/* League header */}
      <div className="flex flex-col items-center mb-8">
        <button
          onClick={() => fileRef.current?.click()}
          className="relative mb-4 group"
          disabled={uploading}
        >
          {league.logo_url ? (
            <img
              src={league.logo_url}
              alt={league.name}
              className="w-24 h-24 rounded-2xl object-cover border border-white/10"
            />
          ) : (
            <div className="w-24 h-24 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-4xl">
              {SPORT_EMOJI[league.sport] ?? "🏆"}
            </div>
          )}
          <div className="absolute inset-0 rounded-2xl bg-black/50 flex items-center justify-center opacity-0 group-active:opacity-100 transition-opacity">
            <span className="text-white text-xs font-bold">
              {uploading ? "Uploading..." : "Change"}
            </span>
          </div>
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={handleLogoUpload}
        />

        <h1 className="text-2xl font-black text-white text-center">{league.name}</h1>
        <p className="text-white/30 text-xs uppercase tracking-widest mt-1">
          {SPORT_LABELS[league.sport] ?? league.sport}
        </p>
      </div>

      {/* Quick actions */}
      <p className="text-white/30 text-xs uppercase tracking-widest mb-3">League</p>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <NavCard
          icon="📅"
          label="Calendar"
          sub="Season schedule"
          onClick={() => router.push(`/season?league_id=${id}`)}
        />
        {showPitboss && (
          <NavCard
            icon="🎓"
            label="Certification"
            sub="Pitboss exams"
            onClick={() => router.push(`/pitboss/cert`)}
          />
        )}
        {showPitboss && (
          <NavCard
            icon="⚠️"
            label="Incidents"
            sub="File a report"
            onClick={() => router.push(`/pitboss/incidents`)}
          />
        )}
        <NavCard
          icon="📖"
          label="Rulebook"
          sub="Regulations"
          onClick={() => router.push(`/league/${id}/rules`)}
        />
        {showPitboss && canSeeStewards && (
          <NavCard
            icon="⚖️"
            label="Stewards"
            sub="Panel & penalties"
            onClick={() => router.push(`/pitboss/steward?league_id=${id}`)}
          />
        )}
      </div>

      {/* Info rows */}
      <p className="text-white/30 text-xs uppercase tracking-widest mb-3">Info</p>
      <div className="flex flex-col gap-3">
        <InfoRow label="Visibility" value={league.is_public ? "Public" : "Private"} />
        <InfoRow label="Seasons" value={league.season_count ?? 0} />
        <InfoRow
          label="Created"
          value={new Date(league.created_at).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        />
        {league.discord_server_id && (
          <InfoRow label="Discord" value={league.discord_server_id} />
        )}
      </div>
    </main>
  );
}

function NavCard({
  icon,
  label,
  sub,
  onClick,
}: {
  icon: string;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-1 text-left active:scale-[0.98] transition-transform"
    >
      <span className="text-2xl">{icon}</span>
      <p className="text-sm font-bold text-white">{label}</p>
      <p className="text-[10px] text-white/30">{sub}</p>
    </button>
  );
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4 flex items-center justify-between">
      <span className="text-white/40 text-sm">{label}</span>
      <span className="text-white text-sm font-semibold">{String(value)}</span>
    </div>
  );
}
