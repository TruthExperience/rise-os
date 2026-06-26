"use client";

import { useState } from "react";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tier = "elite" | "apex" | "apex_pro" | "academy";
type LicenceStatus = "active" | "suspended" | "revoked" | "expired";
type CertStatus = "passed" | "failed" | "in_progress" | "locked";
type IncidentStatus = "open" | "under_review" | "closed" | "dismissed";
type ContractStatus = "active" | "expired" | "voided" | "pending";

interface Platform {
  name: "PSN" | "Xbox" | "Steam" | "Epic";
  gamertag: string;
}

interface LeagueMembership {
  league_id: string;
  league_name: string;
  role: string;
  certified: boolean;
  active: boolean;
}

interface EraEndorsement {
  era: string;
  endorsed_by: string;
  date: string;
}

interface Licence {
  id: string;
  type: string;
  status: LicenceStatus;
  issued: string;
  expires: string;
  division: string;
}

interface CertAttempt {
  id: string;
  cert_name: string;
  status: CertStatus;
  score: number | null;
  pass_mark: number;
  attempted_at: string | null;
}

interface PenaltyPoint {
  id: string;
  points: number;
  reason: string;
  issued_at: string;
  expires_at: string;
  expired: boolean;
}

interface Incident {
  id: string;
  type: string;
  status: IncidentStatus;
  race: string;
  season: string;
  filed_at: string;
  role: "filed_against" | "filed_by";
}

interface Contract {
  id: string;
  status: ContractStatus;
  season: string;
  team: string;
  contract_start: string;
  contract_end: string;
}

interface RaceResult {
  id: string;
  race: string;
  season: string;
  quali: number | null;
  finish: number | null;
  points: number;
  fastest_lap: boolean;
  dnf: boolean;
}

interface DriverProfile {
  id: string;
  name: string;
  discord_id: string;
  discord_username: string;
  member_since: string;
  avatar_url: string | null;
  tier: Tier;
  super_licence: boolean;
  active_league_id: string | null;
  active_pp: number;
  exam_locked: boolean;
  exam_locked_until: string | null; // ISO date string, null = indefinite
  platforms: Platform[];
  league_memberships: LeagueMembership[];
  era_endorsements: EraEndorsement[];
  licences: Licence[];
  cert_attempts: CertAttempt[];
  penalty_points: PenaltyPoint[];
  incidents: Incident[];
  contracts: Contract[];
  results: RaceResult[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Ring color is per-league — each league is isolated and independent.
// The avatar ring reflects which league the driver is actively working in,
// not their tier. Tier badge is shown separately in the hero.
const LEAGUE_RING: Record<string, string> = {
  wsc: "ring-red-500",      // WSC — Ferrari red
  srl: "ring-cyan-400",     // SRL — cyan
  trl: "ring-violet-500",   // TRL — violet
  d2s: "ring-amber-400",    // D2S — amber
  drl: "ring-sky-400",      // DRL — sky blue
};
const DEFAULT_RING = "ring-zinc-500"; // fallback for unknown leagues

const TIER_LABEL: Record<Tier, string> = {
  elite: "Elite",
  apex: "Apex",
  apex_pro: "Apex Pro",
  academy: "Academy",
};

const TIER_TEXT: Record<Tier, string> = {
  elite: "text-yellow-400",
  apex: "text-green-400",
  apex_pro: "text-orange-400",
  academy: "text-zinc-400",
};

const TIER_BG: Record<Tier, string> = {
  elite: "bg-yellow-400/10 text-yellow-400 border-yellow-400/30",
  apex: "bg-green-400/10 text-green-400 border-green-400/30",
  apex_pro: "bg-orange-400/10 text-orange-400 border-orange-400/30",
  academy: "bg-zinc-700 text-zinc-300 border-zinc-600",
};

const LICENCE_BORDER: Record<LicenceStatus, string> = {
  active: "border-l-green-400",
  suspended: "border-l-yellow-400",
  revoked: "border-l-red-500",
  expired: "border-l-zinc-600",
};

const LICENCE_DOT: Record<LicenceStatus, string> = {
  active: "bg-green-400",
  suspended: "bg-yellow-400",
  revoked: "bg-red-500",
  expired: "bg-zinc-500",
};

const PLATFORM_COLOR: Record<string, string> = {
  PSN: "text-blue-400",
  Xbox: "text-green-400",
  Steam: "text-sky-400",
  Epic: "text-purple-400",
};

const INCIDENT_STATUS_STYLE: Record<IncidentStatus, string> = {
  open: "bg-yellow-400/10 text-yellow-400",
  under_review: "bg-blue-400/10 text-blue-400",
  closed: "bg-zinc-700 text-zinc-400",
  dismissed: "bg-zinc-800 text-zinc-500",
};

const CONTRACT_STATUS_STYLE: Record<ContractStatus, string> = {
  active: "bg-green-400/10 text-green-400",
  expired: "bg-zinc-700 text-zinc-400",
  voided: "bg-red-500/10 text-red-400",
  pending: "bg-yellow-400/10 text-yellow-400",
};

type Tab =
  | "overview"
  | "licences"
  | "certifications"
  | "penalties"
  | "incidents"
  | "contracts"
  | "results";

// ─── Mock data (replace with real fetch) ──────────────────────────────────────

const MOCK: DriverProfile = {
  id: "drv_001",
  name: "TheTruthExperien",
  discord_id: "123456789012345678",
  discord_username: "TheTruthExperien#0001",
  member_since: "2023-01-15",
  avatar_url: null,
  tier: "apex_pro",
  super_licence: true,
  active_league_id: "wsc",
  active_pp: 3,
  exam_locked: true,
  exam_locked_until: "2024-07-15",
  platforms: [
    { name: "PSN", gamertag: "TruthExperien" },
    { name: "Steam", gamertag: "TheTruth" },
  ],
  league_memberships: [
    {
      league_id: "wsc",
      league_name: "WSC",
      role: "Co-Owner & Co Head FIA Steward",
      certified: true,
      active: true,
    },
    {
      league_id: "srl",
      league_name: "SRL",
      role: "Administrator",
      certified: true,
      active: true,
    },
  ],
  era_endorsements: [
    { era: "Season 4", endorsed_by: "WSC Council", date: "2024-03-01" },
  ],
  licences: [
    {
      id: "lic_001",
      type: "F1 Super Licence",
      status: "active",
      issued: "2024-01-01",
      expires: "2025-01-01",
      division: "F1",
    },
    {
      id: "lic_002",
      type: "F2 Licence",
      status: "active",
      issued: "2023-06-01",
      expires: "2024-06-01",
      division: "F2",
    },
    {
      id: "lic_003",
      type: "Junior Licence",
      status: "expired",
      issued: "2023-01-01",
      expires: "2023-06-01",
      division: "F2",
    },
  ],
  cert_attempts: [
    {
      id: "ca_001",
      cert_name: "Chief Steward",
      status: "passed",
      score: 92,
      pass_mark: 80,
      attempted_at: "2024-02-10",
    },
    {
      id: "ca_002",
      cert_name: "Senior Steward",
      status: "passed",
      score: 88,
      pass_mark: 75,
      attempted_at: "2023-11-05",
    },
    {
      id: "ca_003",
      cert_name: "Junior Steward",
      status: "passed",
      score: 85,
      pass_mark: 70,
      attempted_at: "2023-08-20",
    },
    {
      id: "ca_004",
      cert_name: "F2 Division Cert",
      status: "in_progress",
      score: null,
      pass_mark: 70,
      attempted_at: null,
    },
  ],
  penalty_points: [
    {
      id: "pp_001",
      points: 2,
      reason: "Unsafe release — Bahrain GP",
      issued_at: "2024-03-05",
      expires_at: "2024-09-05",
      expired: false,
    },
    {
      id: "pp_002",
      points: 1,
      reason: "Causing collision — Qatar GP",
      issued_at: "2024-02-18",
      expires_at: "2024-08-18",
      expired: false,
    },
    {
      id: "pp_003",
      points: 3,
      reason: "Forcing another driver off track — Spa",
      issued_at: "2023-08-27",
      expires_at: "2024-02-27",
      expired: true,
    },
  ],
  incidents: [
    {
      id: "inc_001",
      type: "Collision",
      status: "closed",
      race: "Bahrain GP",
      season: "S4",
      filed_at: "2024-03-04",
      role: "filed_against",
    },
    {
      id: "inc_002",
      type: "Track limits",
      status: "dismissed",
      race: "Qatar GP",
      season: "S4",
      filed_at: "2024-02-17",
      role: "filed_against",
    },
    {
      id: "inc_003",
      type: "Dangerous driving",
      status: "closed",
      race: "Jeddah GP",
      season: "S4",
      filed_at: "2024-01-21",
      role: "filed_by",
    },
  ],
  contracts: [
    {
      id: "con_001",
      status: "active",
      season: "S4",
      team: "WSC Scuderia Ferrari",
      contract_start: "2024-01-01",
      contract_end: "2024-12-31",
    },
    {
      id: "con_002",
      status: "active",
      season: "S4",
      team: "WSC Prema Racing",
      contract_start: "2024-01-01",
      contract_end: "2024-12-31",
    },
  ],
  results: [
    {
      id: "res_001",
      race: "Bahrain GP",
      season: "S4",
      quali: 3,
      finish: 1,
      points: 25,
      fastest_lap: true,
      dnf: false,
    },
    {
      id: "res_002",
      race: "Qatar GP",
      season: "S4",
      quali: 5,
      finish: 3,
      points: 15,
      fastest_lap: false,
      dnf: false,
    },
    {
      id: "res_003",
      race: "Jeddah GP",
      season: "S4",
      quali: 2,
      finish: null,
      points: 0,
      fastest_lap: false,
      dnf: true,
    },
    {
      id: "res_004",
      race: "Spa GP",
      season: "S3",
      quali: 1,
      finish: 2,
      points: 18,
      fastest_lap: false,
      dnf: false,
    },
  ],
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Avatar({
  driver,
  size = 20,
}: {
  driver: DriverProfile;
  size?: number;
}) {
  const sizeClass = size === 20 ? "w-20 h-20" : "w-14 h-14";
  const initials = driver.name.slice(0, 2).toUpperCase();

  // Ring reflects the active league — each league is independent.
  // Switching active_league_id changes the ring; tier is shown via badge only.
  const ringClass = driver.active_league_id
    ? (LEAGUE_RING[driver.active_league_id] ?? DEFAULT_RING)
    : DEFAULT_RING;

  const activeLeague = driver.league_memberships.find(
    (m) => m.league_id === driver.active_league_id
  );

  return (
    <div className="relative inline-block">
      <div
        className={`${sizeClass} rounded-full ring-4 ${ringClass} ring-offset-2 ring-offset-zinc-950 overflow-hidden flex items-center justify-center bg-zinc-800`}
        title={
          activeLeague
            ? `Active in ${activeLeague.league_name}`
            : "No active league"
        }
      >
        {driver.avatar_url ? (
          <img
            src={driver.avatar_url}
            alt={driver.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className={`font-bold text-lg ${TIER_TEXT[driver.tier]}`}>
            {initials}
          </span>
        )}
      </div>
      {activeLeague && (
        <span
          className="absolute -bottom-1 -right-1 text-[9px] font-bold bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 leading-none"
          style={{ color: "inherit" }}
        >
          {activeLeague.league_name}
        </span>
      )}
    </div>
  );
}

function Badge({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${className}`}
    >
      {children}
    </span>
  );
}

function StatCell({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: string;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-2">
      <span
        className={`text-xl font-bold tabular-nums ${highlight ?? "text-white"}`}
      >
        {value}
      </span>
      <span className="text-[10px] text-zinc-500 uppercase tracking-widest mt-0.5">
        {label}
      </span>
    </div>
  );
}

// ─── Tab sections ─────────────────────────────────────────────────────────────

function OverviewTab({ driver }: { driver: DriverProfile }) {
  return (
    <div className="space-y-6">
      {/* Platforms */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
          Platforms
        </h3>
        <div className="flex flex-wrap gap-3">
          {driver.platforms.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2"
            >
              <span
                className={`text-xs font-bold ${PLATFORM_COLOR[p.name] ?? "text-zinc-400"}`}
              >
                {p.name}
              </span>
              <span className="text-sm text-zinc-300">{p.gamertag}</span>
            </div>
          ))}
        </div>
      </section>

      {/* League memberships */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
          League Memberships
        </h3>
        <div className="space-y-2">
          {driver.league_memberships.map((m) => (
            <div
              key={m.league_id}
              className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-white">
                  {m.league_name}
                </span>
                <span className="text-xs text-zinc-400">{m.role}</span>
              </div>
              <div className="flex items-center gap-2">
                {m.certified && (
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30">
                    ✓ Certified
                  </Badge>
                )}
                {m.active ? (
                  <Badge className="bg-green-400/10 text-green-400 border-green-400/30">
                    Active
                  </Badge>
                ) : (
                  <Badge className="bg-zinc-700 text-zinc-400 border-zinc-600">
                    Inactive
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Era endorsements */}
      {driver.era_endorsements.length > 0 && (
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
            Era Endorsements
          </h3>
          <div className="space-y-2">
            {driver.era_endorsements.map((e, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
              >
                <div>
                  <span className="text-sm font-medium text-white">
                    {e.era}
                  </span>
                  <span className="text-xs text-zinc-500 ml-2">
                    by {e.endorsed_by}
                  </span>
                </div>
                <span className="text-xs text-zinc-500">{e.date}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Identity */}
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
          Identity
        </h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
          {[
            { label: "Discord ID", value: driver.discord_id },
            { label: "Username", value: driver.discord_username },
            {
              label: "Member Since",
              value: new Date(driver.member_since).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              }),
            },
          ].map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between px-4 py-3"
            >
              <span className="text-xs text-zinc-500">{row.label}</span>
              <span className="text-sm text-zinc-200 font-mono">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function LicencesTab({ driver }: { driver: DriverProfile }) {
  return (
    <div className="space-y-3">
      {driver.licences.map((lic) => (
        <Link key={lic.id} href={`/pitboss/licences/${lic.id}`}>
          <div
            className={`bg-zinc-900 border border-zinc-800 border-l-4 ${LICENCE_BORDER[lic.status]} rounded-lg px-4 py-4 hover:bg-zinc-800/60 transition-colors cursor-pointer`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold text-white">{lic.type}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {lic.division} · Issued {lic.issued} · Expires {lic.expires}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${LICENCE_DOT[lic.status]}`}
                />
                <span className="text-xs capitalize text-zinc-400">
                  {lic.status}
                </span>
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function CertificationsTab({ driver }: { driver: DriverProfile }) {
  const counts = {
    passed: driver.cert_attempts.filter((c) => c.status === "passed").length,
    failed: driver.cert_attempts.filter((c) => c.status === "failed").length,
    in_progress: driver.cert_attempts.filter((c) => c.status === "in_progress")
      .length,
    locked: driver.cert_attempts.filter((c) => c.status === "locked").length,
  };

  const CERT_GRID = [
    {
      key: "passed",
      label: "Passed",
      color: "text-green-400",
      count: counts.passed,
    },
    {
      key: "failed",
      label: "Failed",
      color: "text-red-400",
      count: counts.failed,
    },
    {
      key: "in_progress",
      label: "In Progress",
      color: "text-yellow-400",
      count: counts.in_progress,
    },
    {
      key: "locked",
      label: "Locked",
      color: "text-zinc-500",
      count: counts.locked,
    },
  ];

  const CERT_STATUS_STYLE: Record<CertStatus, string> = {
    passed: "bg-green-400/10 text-green-400 border-green-400/30",
    failed: "bg-red-500/10 text-red-400 border-red-500/30",
    in_progress: "bg-yellow-400/10 text-yellow-400 border-yellow-400/30",
    locked: "bg-zinc-800 text-zinc-500 border-zinc-700",
  };

  return (
    <div className="space-y-6">
      {/* Summary grid */}
      <div className="grid grid-cols-4 divide-x divide-zinc-800 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {CERT_GRID.map((g) => (
          <div key={g.key} className="flex flex-col items-center py-4">
            <span className={`text-2xl font-bold ${g.color}`}>{g.count}</span>
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">
              {g.label}
            </span>
          </div>
        ))}
      </div>

      {/* Attempt history */}
      <div className="space-y-2">
        {driver.cert_attempts.map((c) => (
          <div
            key={c.id}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">{c.cert_name}</p>
                {c.attempted_at && (
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Attempted {c.attempted_at}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {c.score !== null && (
                  <span className="text-xs text-zinc-400 tabular-nums">
                    {c.score}/{c.pass_mark} pass
                  </span>
                )}
                <Badge className={CERT_STATUS_STYLE[c.status]}>
                  {c.status.replace("_", " ")}
                </Badge>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PenaltiesTab({ driver }: { driver: DriverProfile }) {
  const activePP = driver.penalty_points
    .filter((p) => !p.expired)
    .reduce((s, p) => s + p.points, 0);

  const active = driver.penalty_points.filter((p) => !p.expired);
  const history = driver.penalty_points.filter((p) => p.expired);

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div
        className={`rounded-xl border px-6 py-5 flex items-center gap-5 ${
          activePP === 0
            ? "bg-green-400/5 border-green-400/20"
            : "bg-orange-400/5 border-orange-400/20"
        }`}
      >
        <span
          className={`text-5xl font-black tabular-nums ${activePP === 0 ? "text-green-400" : "text-orange-400"}`}
        >
          {activePP}
        </span>
        <div>
          <p
            className={`text-base font-semibold ${activePP === 0 ? "text-green-400" : "text-orange-400"}`}
          >
            {activePP === 0 ? "Clean licence" : "Active penalty points"}
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            {activePP === 0
              ? "No current points on licence"
              : `${active.length} active issuance${active.length !== 1 ? "s" : ""}`}
          </p>
        </div>
      </div>

      {/* Active */}
      {active.length > 0 && (
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
            Active
          </h3>
          <div className="space-y-2">
            {active.map((p) => (
              <div
                key={p.id}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-white">{p.reason}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Issued {p.issued_at} · Expires {p.expires_at}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-orange-400 ml-4">
                    +{p.points}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* History */}
      {history.length > 0 && (
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
            History
          </h3>
          <div className="space-y-2">
            {history.map((p) => (
              <div
                key={p.id}
                className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3 opacity-60"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-zinc-400">{p.reason}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">
                      Expired {p.expires_at}
                    </p>
                  </div>
                  <span className="text-base font-bold text-zinc-600 ml-4">
                    +{p.points}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function IncidentsTab({ driver }: { driver: DriverProfile }) {
  const against = driver.incidents.filter((i) => i.role === "filed_against");
  const by = driver.incidents.filter((i) => i.role === "filed_by");

  const IncidentCard = ({ inc }: { inc: Incident }) => (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-white">{inc.type}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {inc.race} · {inc.season} · Filed {inc.filed_at}
          </p>
        </div>
        <Badge className={INCIDENT_STATUS_STYLE[inc.status]}>
          {inc.status.replace("_", " ")}
        </Badge>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
          Filed Against ({against.length})
        </h3>
        {against.length === 0 ? (
          <p className="text-sm text-zinc-600 py-4 text-center">No incidents</p>
        ) : (
          <div className="space-y-2">
            {against.map((i) => (
              <IncidentCard key={i.id} inc={i} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3">
          Filed By ({by.length})
        </h3>
        {by.length === 0 ? (
          <p className="text-sm text-zinc-600 py-4 text-center">No incidents</p>
        ) : (
          <div className="space-y-2">
            {by.map((i) => (
              <IncidentCard key={i.id} inc={i} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ContractsTab({ driver }: { driver: DriverProfile }) {
  return (
    <div className="space-y-3">
      {driver.contracts.length === 0 ? (
        <p className="text-sm text-zinc-600 py-8 text-center">No contracts</p>
      ) : (
        driver.contracts.map((c) => (
          <div
            key={c.id}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-4"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-white">{c.team}</p>
                <p className="text-xs text-zinc-500 mt-0.5">Season {c.season}</p>
              </div>
              <Badge className={CONTRACT_STATUS_STYLE[c.status]}>
                {c.status}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Start", value: c.contract_start },
                { label: "End", value: c.contract_end },
              ].map((row) => (
                <div
                  key={row.label}
                  className="bg-zinc-800 rounded px-3 py-2"
                >
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    {row.label}
                  </p>
                  <p className="text-xs text-zinc-200 mt-0.5 font-mono">
                    {row.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ResultsTab({ driver }: { driver: DriverProfile }) {
  const wins = driver.results.filter((r) => r.finish === 1).length;
  const podiums = driver.results.filter(
    (r) => r.finish !== null && r.finish <= 3
  ).length;
  const dnfs = driver.results.filter((r) => r.dnf).length;
  const totalPoints = driver.results.reduce((s, r) => s + r.points, 0);
  const poles = driver.results.filter((r) => r.quali === 1).length;
  const fls = driver.results.filter((r) => r.fastest_lap).length;

  const SUMMARY = [
    { label: "Starts", value: driver.results.length },
    { label: "Wins", value: wins, highlight: "text-yellow-400" },
    { label: "Podiums", value: podiums, highlight: "text-green-400" },
    { label: "Points", value: totalPoints },
    { label: "Poles", value: poles },
    { label: "DNFs", value: dnfs, highlight: dnfs > 0 ? "text-red-400" : undefined },
  ];

  function finishDisplay(r: RaceResult) {
    if (r.dnf) return <span className="text-red-400 font-bold">DNF</span>;
    if (r.finish === null) return <span className="text-zinc-600">—</span>;
    if (r.finish === 1)
      return <span className="text-yellow-400 font-bold">P1</span>;
    if (r.finish <= 3)
      return <span className="text-green-400 font-bold">P{r.finish}</span>;
    return <span className="text-zinc-300">P{r.finish}</span>;
  }

  return (
    <div className="space-y-6">
      {/* Summary grid */}
      <div className="grid grid-cols-3 gap-px bg-zinc-800 rounded-xl overflow-hidden border border-zinc-800">
        {SUMMARY.map((s) => (
          <div
            key={s.label}
            className="bg-zinc-900 flex flex-col items-center py-4"
          >
            <span
              className={`text-2xl font-bold tabular-nums ${s.highlight ?? "text-white"}`}
            >
              {s.value}
            </span>
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {/* Results table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] text-[10px] uppercase tracking-widest text-zinc-600 px-4 py-2 border-b border-zinc-800">
          <span>Race</span>
          <span className="text-center w-10">Quali</span>
          <span className="text-center w-12">Finish</span>
          <span className="text-center w-10">Pts</span>
          <span className="text-center w-6">FL</span>
        </div>
        <div className="divide-y divide-zinc-800/50">
          {driver.results.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] px-4 py-3 items-center"
            >
              <div>
                <p className="text-sm text-white">{r.race}</p>
                <p className="text-[10px] text-zinc-600">{r.season}</p>
              </div>
              <span className="text-xs text-zinc-400 w-10 text-center tabular-nums">
                {r.quali ? `P${r.quali}` : "—"}
              </span>
              <span className="text-xs w-12 text-center tabular-nums">
                {finishDisplay(r)}
              </span>
              <span className="text-xs text-zinc-300 w-10 text-center tabular-nums">
                {r.points}
              </span>
              <span className="text-xs w-6 text-center">
                {r.fastest_lap ? (
                  <span className="text-purple-400 font-bold">FL</span>
                ) : (
                  <span className="text-zinc-700">—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function DriverProfilePage() {
  // In production: const driver = await fetchDriver(params.id)
  const driver = MOCK;
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const activePP = driver.penalty_points
    .filter((p) => !p.expired)
    .reduce((s, p) => s + p.points, 0);

  const certsPassed = driver.cert_attempts.filter(
    (c) => c.status === "passed"
  ).length;
  const activeLicences = driver.licences.filter(
    (l) => l.status === "active"
  ).length;
  const starts = driver.results.length;
  const wins = driver.results.filter((r) => r.finish === 1).length;

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "licences", label: "Licences", count: driver.licences.length },
    { id: "certifications", label: "Certs", count: certsPassed },
    {
      id: "penalties",
      label: "Penalties",
      count: activePP > 0 ? activePP : undefined,
    },
    { id: "incidents", label: "Incidents", count: driver.incidents.length > 0 ? driver.incidents.length : undefined },
    { id: "contracts", label: "Contracts", count: driver.contracts.length > 0 ? driver.contracts.length : undefined },
    { id: "results", label: "Results", count: starts > 0 ? starts : undefined },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-2xl mx-auto px-4 pb-20">
        {/* ── Hero ── */}
        <div className="pt-8 pb-6">
          <div className="flex items-start gap-5">
            <Avatar driver={driver} size={20} />
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-white truncate">
                {driver.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Badge className={TIER_BG[driver.tier]}>
                  {TIER_LABEL[driver.tier]}
                </Badge>
                {driver.super_licence && (
                  <Badge className="bg-yellow-400/10 text-yellow-300 border-yellow-400/20">
                    ★ Super Licence
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* Stat strip */}
          <div className="mt-5 grid grid-cols-5 divide-x divide-zinc-800 bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden">
            <StatCell
              label="PP"
              value={activePP}
              highlight={activePP > 0 ? "text-orange-400" : "text-green-400"}
            />
            <StatCell label="Licences" value={activeLicences} />
            <StatCell label="Certs" value={certsPassed} />
            <StatCell label="Starts" value={starts} />
            <StatCell label="Wins" value={wins} highlight="text-yellow-400" />
          </div>
        </div>

        {/* ── Exam lockout banner ── */}
        {driver.exam_locked && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5 px-4 py-3">
            <span className="mt-0.5 text-yellow-400 text-base leading-none">⚠</span>
            <div>
              <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wider">
                Exam Lockout Active
              </p>
              <p className="text-xs text-zinc-400 mt-0.5">
                {driver.exam_locked_until
                  ? `Locked from sitting exams until ${new Date(driver.exam_locked_until).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`
                  : "Locked from sitting exams indefinitely. Contact a Chief Steward to resolve."}
              </p>
            </div>
          </div>
        )}

        {/* ── Sticky tabs ── */}
        <div className="sticky top-0 z-20 bg-zinc-950/90 backdrop-blur-sm -mx-4 px-4 border-b border-zinc-800 mb-6">
          <div className="flex gap-0 overflow-x-auto scrollbar-none">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                  activeTab === tab.id
                    ? "text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span
                    className={`text-[10px] font-bold rounded px-1 py-0.5 leading-none ${
                      activeTab === tab.id
                        ? "bg-white/10 text-white"
                        : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
                {activeTab === tab.id && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-white rounded-t" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ── */}
        {activeTab === "overview" && <OverviewTab driver={driver} />}
        {activeTab === "licences" && <LicencesTab driver={driver} />}
        {activeTab === "certifications" && (
          <CertificationsTab driver={driver} />
        )}
        {activeTab === "penalties" && <PenaltiesTab driver={driver} />}
        {activeTab === "incidents" && <IncidentsTab driver={driver} />}
        {activeTab === "contracts" && <ContractsTab driver={driver} />}
        {activeTab === "results" && <ResultsTab driver={driver} />}
      </div>
    </div>
  );
}
