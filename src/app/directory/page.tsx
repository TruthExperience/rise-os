import Link from "next/link";
import { getPublicLeagues } from "@/lib/public-league";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Rise OS — Sports Dynasty Governance Layer",
  description:
    "The infrastructure multiple sim racing and dynasty leagues run on.",
};

const SPORT_LABEL: Record<string, string> = {
  sim_racing: "Sim racing",
  cfb: "College football dynasty",
};

export default async function DirectoryPage() {
  const leagues = await getPublicLeagues();

  return (
    <main className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10 px-6 py-16 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <p className="text-sm text-white/50">TOPS Ecosystem</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Rise OS
          </h1>
          <p className="mt-4 max-w-xl text-lg text-white/70">
            The governance layer running standings, stewarding, and rosters
            for seven active leagues — sim racing and college football
            dynasties alike.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-md bg-[#E8284A] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-[#d31f3f]"
            >
              Already in a league? Sign in
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-14 sm:px-10">
        <h2 className="text-lg font-medium text-white/90">Active leagues</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {leagues.map((league) => (
            <Link
              key={league.id}
              href={`/l/${league.slug}`}
              className="group rounded-lg border border-white/10 bg-white/[0.03] p-5 transition hover:border-[#E8284A]/50 hover:bg-white/[0.05]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-medium text-white">
                    {league.name}
                  </h3>
                  <p className="mt-1 text-sm text-white/50">
                    {SPORT_LABEL[league.sport] ?? league.sport}
                  </p>
                </div>
                {league.pitbossStatus === "trial" && (
                  <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/60">
                    Trial
                  </span>
                )}
              </div>
              <p className="mt-4 text-sm text-[#E8284A] group-hover:underline">
                View league
              </p>
            </Link>
          ))}
        </div>
        {leagues.length === 0 && (
          <p className="mt-4 text-sm text-white/50">
            No public leagues are live yet.
          </p>
        )}
      </section>

      <footer className="border-t border-white/10 px-6 py-8 text-sm text-white/40 sm:px-10">
        TOPS Ecosystem · Rise OS v0.1
      </footer>
    </main>
  );
}
