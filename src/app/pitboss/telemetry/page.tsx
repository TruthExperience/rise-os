import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthedDriver } from "@/lib/supabase/server";
import { getStewardLeagueIds, listTelemetrySessionsForDriver } from "@/lib/telemetry";

export default async function TelemetryListPage() {
  const driver = await getAuthedDriver();
  if (!driver) redirect("/login");

  const stewardLeagueIds = await getStewardLeagueIds(driver.id);
  const sessions = await listTelemetrySessionsForDriver(driver.id, stewardLeagueIds);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-6 font-mono text-lg uppercase tracking-widest text-[#E7EAEE]">
        Telemetry Sessions
      </h1>

      {sessions.length === 0 ? (
        <p className="font-mono text-sm text-[#5B6572]">No telemetry sessions found.</p>
      ) : (
        <div className="divide-y divide-[#262B33] overflow-hidden rounded-md border border-[#262B33]">
          {sessions.map((s) => (
            <Link
              key={s.sessionUid}
              href={`/pitboss/telemetry/${encodeURIComponent(s.sessionUid)}`}
              className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-[#14181D]"
            >
              <div>
                <div className="font-mono text-sm text-[#E7EAEE]">
                  {s.trackName ?? "Unknown Circuit"}
                </div>
                <div className="font-mono text-xs text-[#5B6572]">
                  {s.lapCount} lap{s.lapCount === 1 ? "" : "s"} ·{" "}
                  {new Date(s.uploadedAt).toLocaleString()}
                  {s.driverId !== driver.id && " · steward view"}
                </div>
              </div>
              <span className="font-mono text-xs text-[#5B6572]">→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
