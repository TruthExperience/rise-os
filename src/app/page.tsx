// src/app/page.tsx
import Link from "next/link";
import { getPublicLeagues } from "@/lib/public-league";

export const revalidate = 300;

const STEPS = [
  {
    n: "01",
    title: "Check in",
    body: "Check-in embeds per round and division. Reminders at 3 hours, 1 hour and 5 minutes, aimed at the drivers who haven't answered.",
  },
  {
    n: "02",
    title: "Race",
    body: "Live telemetry dashboard and driver setups with a feedback loop, so the car is ready before lights out.",
  },
  {
    n: "03",
    title: "Results",
    body: "Results and standings kept in one place and posted to Discord.",
  },
  {
    n: "04",
    title: "Steward",
    body: "Incident reports with evidence, steward decisions, a penalty ledger and appeals, with an AI steward grounded in your rulebook.",
  },
];

export default async function Home() {
  let leagueCount = 0;
  try {
    leagueCount = (await getPublicLeagues()).length;
  } catch {
    leagueCount = 0;
  }

  return (
    <main className="min-h-screen bg-rise-black px-6 pb-24 pt-10">
      <div className="mx-auto max-w-xl">
        {/* Brand */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rise-red">
              <span className="text-lg font-black text-white">R</span>
            </div>
            <span className="text-xl font-black tracking-tight text-white">
              Rise <span className="text-rise-red">OS</span>
            </span>
          </div>
          <Link
            href="/login"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/60 transition hover:text-white"
          >
            Sign in
          </Link>
        </div>

        {/* Hero */}
        <h1 className="mt-16 text-5xl font-black leading-[1.05] tracking-tight text-white">
          Run the league.
          <br />
          <span className="text-rise-red">Keep it fair.</span>
        </h1>
        <p className="mt-5 text-base leading-relaxed text-white/60">
          Check-ins, results, standings, stewarding and live telemetry for sim
          racing leagues, run from one place and working through Discord.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="rounded-md bg-rise-red px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Sign in
          </Link>
          <Link
            href="/directory"
            className="rounded-md border border-white/10 bg-white/5 px-5 py-3 text-sm font-medium text-white/80 transition hover:text-white"
          >
            Browse leagues
          </Link>
        </div>

        <p className="mt-3 text-xs text-white/30">
          Sign in with Discord or email.
        </p>

        {leagueCount > 0 && (
          <p className="mt-6 text-xs uppercase tracking-widest text-white/30">
            {leagueCount} active {leagueCount === 1 ? "league" : "leagues"}{" "}
            racing on Rise OS
          </p>
        )}

        {/* Race weekend, end to end */}
        <p className="mb-3 mt-16 text-xs uppercase tracking-widest text-white/30">
          A race weekend, end to end
        </p>
        <div className="space-y-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="rounded-2xl border border-white/10 bg-white/5 p-5"
            >
              <p className="font-mono text-xs text-rise-red">{s.n}</p>
              <p className="mt-1 text-lg font-bold text-white">{s.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-white/50">
                {s.body}
              </p>
            </div>
          ))}
        </div>

        {/* Beyond racing */}
        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-5">
          <p className="text-lg font-bold text-white">More than racing</p>
          <p className="mt-1 text-sm leading-relaxed text-white/50">
            The same governance layer runs college football dynasty leagues:
            franchises, rosters and season operations.
          </p>
        </div>

        <p className="mt-16 text-center text-xs text-white/20">
          TOPS Ecosystem · Rise OS beta 1.0
        </p>
      </div>
    </main>
  );
}
