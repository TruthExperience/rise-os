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

  const { league, standings, nextRound, schedule, rules, documents } = data;

  return (
    <main className="min-h-screen bg-rise-black px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <Link
            href="/directory"
            className="text-sm text-white/40 transition-colors hover:text-white"
          >
            ← Rise OS
          </Link>
          <Link
            href="/login"
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/50 transition-colors hover:text-white"
          >
            Sign in
          </Link>
        </div>

        <div className="mt-8 flex items-center gap-4">
          {league.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={league.logoUrl}
              alt={`${league.name} logo`}
              className="h-16 w-16 flex-shrink-0 rounded-2xl border-2 border-rise-red/40 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-2xl font-bold text-white/30">
              {league.name.charAt(0)}
            </div>
          )}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-rise-red">
              {league.sport === "cfb" ? "College football dynasty" : "Sim racing"}
            </p>
            <h1 className="mt-1 text-2xl font-black text-white">{league.name}</h1>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 lg:col-span-2">
            <p className="text-xs uppercase tracking-widest text-white/30">Next race</p>
            {nextRound ? (
              <div className="mt-3">
                <p className="text-xl font-bold text-white">
                  {nextRound.name ?? `Round ${nextRound.roundNumber}`}
                </p>
                <p className="mt-1 text-white/50">
                  {[nextRound.circuit, nextRound.country].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-3 text-sm text-white/40">
                  {nextRound.raceDate
                    ? `Lights out ${formatRaceDate(nextRound.raceDate)}`
                    : "Date to be announced"}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-white/40">
                Calendar for this league hasn&apos;t been published yet.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <p className="text-xs uppercase tracking-widest text-white/30">Title fight</p>
            {standings.length > 0 ? (
              <ol className="mt-3 space-y-3">
                {standings.map((s, i) => (
                  <li key={s.driverId} className="flex items-center justify-between">
                    <span className="text-white/70">
                      {i + 1}. Driver {s.driverId.slice(0, 8)}
                    </span>
                    <span className="text-white/40">{s.points} pts</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-white/40">
                Standings haven&apos;t been posted for this season yet.
              </p>
            )}
          </div>
        </div>

        <p className="mb-3 mt-10 text-xs uppercase tracking-widest text-white/30">
          Schedule
        </p>
        {schedule.length > 0 ? (
          <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/5">
            {schedule.map((r, i) => (
              <div
                key={`${r.seasonNumber}-${r.roundNumber ?? "break"}-${i}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
              >
                <span className="w-8 text-sm text-white/30">{r.roundNumber ?? "—"}</span>
                <span className="flex-1 text-white/80">
                  {r.name ?? "TBD"}
                  {r.isSprint && (
                    <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/40">
                      Sprint
                    </span>
                  )}
                </span>
                <span className="text-sm text-white/30">
                  {[r.circuit, r.country].filter(Boolean).join(" · ")}
                </span>
                <span className="text-sm text-white/30">
                  {r.raceDate ? formatRaceDate(r.raceDate) : "TBD"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-white/40">
            Calendar for this league hasn&apos;t been published yet.
          </p>
        )}

        <p className="mb-3 mt-10 text-xs uppercase tracking-widest text-white/30">
          Regulations
        </p>
        {rules.length > 0 ? (
          <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/5">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-4 px-5 py-3">
                <span className="text-sm text-white/30">{r.articleNumber ?? "—"}</span>
                <span className="text-white/80">{r.title}</span>
                {r.chapter && (
                  <span className="ml-auto text-xs text-white/30">{r.chapter}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-white/40">No published rulebook for this league yet.</p>
        )}

        <p className="mb-3 mt-10 text-xs uppercase tracking-widest text-white/30">
          Documents
        </p>
        {documents.filter((d) => d.url).length > 0 ? (
          <div className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/5">
            {documents
              .filter((d) => d.url)
              .map((d) => (
                <div key={d.id} className="flex items-center gap-4 px-5 py-3">
                  <div>
                    <p className="text-white/80">{d.title}</p>
                    {(d.documentCode || d.version) && (
                      <p className="text-xs text-white/30">
                        {[d.documentCode, d.version].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <a
                    href={d.url!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-sm font-medium text-rise-red hover:underline"
                  >
                    Download
                  </a>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-white/40">No published documents for this league yet.</p>
        )}

        <p className="mt-10 text-center text-xs text-white/20">
          TOPS Ecosystem · Rise OS v0.1
        </p>
      </div>
    </main>
  );
}
