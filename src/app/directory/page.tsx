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
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-white">
              Rise <span className="text-rise-red">OS</span>
            </h1>
            <p className="mt-1 text-xs uppercase tracking-widest text-white/30">
              Sports Dynasty Governance
            </p>
          </div>
          <Link
            href="/login"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/50 transition-colors hover:text-white"
          >
            Sign in
          </Link>
        </div>

        <p className="mt-6 max-w-xl text-white/60">
          The governance layer running standings, stewarding, and rosters for
          seven active leagues — sim racing and college football dynasties
          alike.
        </p>

        <p className="mb-3 mt-10 text-xs uppercase tracking-widest text-white/30">
          Active leagues
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {leagues.map((league) => (
            <Link key={league.id} href={`/l/${league.slug}`}>
              <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-5 transition-transform active:scale-[0.98]">
                {league.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={league.logoUrl}
                    alt={`${league.name} logo`}
                    className="h-12 w-12 flex-shrink-0 rounded-xl border-2 border-rise-red/40 object-cover"
                  />
                ) : (
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-lg font-bold text-white/30">
                    {league.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1">
                  <p className="font-bold text-white">{league.name}</p>
                  <p className="text-sm text-white/40">
                    {SPORT_LABEL[league.sport] ?? league.sport}
                  </p>
                </div>
                {league.pitbossStatus === "trial" && (
                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/50">
                    Trial
                  </span>
                )}
                <span className="text-lg text-white/20">›</span>
              </div>
            </Link>
          ))}
        </div>
        {leagues.length === 0 && (
          <p className="mt-4 text-sm text-white/50">
            No public leagues are live yet.
          </p>
        )}

        <p className="mt-10 text-center text-xs text-white/20">
          TOPS Ecosystem · Rise OS v0.1
        </p>
      </div>
    </main>
  );
}
