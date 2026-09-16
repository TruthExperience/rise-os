import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicLeagueBySlug } from "@/lib/public-league";

export const dynamic = "force-dynamic";

type Props = {
  params: { slug: string };
};

export async function generateMetadata({ params }: Props) {
  const data = await getPublicLeagueBySlug(params.slug);
  if (!data) return {};
  return {
    title: `${data.league.name} — Rise OS`,
  };
}

function formatRaceDate(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function LeaguePage({ params }: Props) {
  const data = await getPublicLeagueBySlug(params.slug);
  if (!data) notFound();

  const { league, standings, nextRound, rules } = data;

  return (
    <main className="min-h-screen bg-black text-white">
      <nav className="border-b border-white/10 px-6 py-4 sm:px-10">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/directory" className="text-sm text-white/50 hover:text-white">
            ← Rise OS
          </Link>
          <Link
            href="/login"
            className="text-sm text-white/70 hover:text-white"
          >
            Sign in
          </Link>
        </div>
      </nav>

      <header className="border-b border-white/10 px-6 py-16 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <p className="text-sm text-[#E8284A]">
            {league.sport === "cfb" ? "College football dynasty" : "Sim racing"}
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            {league.name}
          </h1>
        </div>
      </header>

      <section className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-6 py-14 sm:px-10 lg:grid-cols-3">
        {/* Next race */}
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 lg:col-span-2">
          <h2 className="text-sm font-medium text-white/50">Next race</h2>
          {nextRound ? (
            <div className="mt-3">
              <p className="text-2xl font-semibold">
                {nextRound.name ?? `Round ${nextRound.roundNumber}`}
              </p>
              <p className="mt-1 text-white/60">
                {[nextRound.circuit, nextRound.country]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <p className="mt-4 text-sm text-white/50">
                Lights out {formatRaceDate(nextRound.raceDate)}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-white/50">
              Calendar for this league hasn&apos;t been published yet.
            </p>
          )}
        </div>

        {/* Standings */}
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-sm font-medium text-white/50">Title fight</h2>
          {standings.length > 0 ? (
            <ol className="mt-3 space-y-3">
              {standings.map((s, i) => (
                <li key={s.driverId} className="flex items-center justify-between">
                  <span className="text-white/80">
                    {i + 1}. Driver {s.driverId.slice(0, 8)}
                  </span>
                  <span className="text-white/50">{s.points} pts</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-white/50">
              Standings haven&apos;t been posted for this season yet.
            </p>
          )}
        </div>
      </section>

      {/* Governance / rulebook */}
      <section className="border-t border-white/10 px-6 py-14 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-lg font-medium">Regulations</h2>
          {rules.length > 0 ? (
            <ul className="mt-6 divide-y divide-white/10 rounded-lg border border-white/10">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center gap-4 px-5 py-3">
                  <span className="text-sm text-white/40">
                    {r.articleNumber ?? "—"}
                  </span>
                  <span className="text-white/85">{r.title}</span>
                  {r.chapter && (
                    <span className="ml-auto text-xs text-white/40">
                      {r.chapter}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-white/50">
              No published rulebook for this league yet.
            </p>
          )}
        </div>
      </section>

      <footer className="border-t border-white/10 px-6 py-8 text-sm text-white/40 sm:px-10">
        TOPS Ecosystem · Rise OS v0.1
      </footer>
    </main>
  );
}
