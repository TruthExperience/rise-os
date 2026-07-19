import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Backs the Career tab (components/pitboss/DriverCareerCard.tsx), which was
// previously fetching this exact path with no route behind it — every load
// 404'd and the client tried to JSON-parse Next's HTML error page, surfacing
// as "The string did not match the expected pattern." on iOS.
//
// pitboss.results has 0 rows league-wide right now (race-result entry isn't
// built yet), so this mirrors DriverCareerCard's expectations: an explicit
// has_results flag, and a driver_contracts-based fallback for "Teams Driven
// For" so that section isn't empty just because results are.

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export const dynamic = "force-dynamic";

type ResultRow = {
  franchise_id: string | null;
  finish_position: number | null;
  qualifying_position: number | null;
  dnf: boolean | null;
  fastest_lap: boolean | null;
  round_id: string | null;
};

type FranchiseRow = {
  id: string;
  name: string;
  abbreviation: string | null;
  logo_url: string | null;
  primary_color: string | null;
};

function summarize(results: ResultRow[], sprintRoundIds: Set<string>) {
  const isSprint = (r: ResultRow) => r.round_id != null && sprintRoundIds.has(r.round_id);
  const classified = results.filter((r) => !r.dnf && r.finish_position != null);
  const feature = classified.filter((r) => !isSprint(r));

  return {
    starts: results.length,
    wins: feature.filter((r) => r.finish_position === 1).length,
    top3: feature.filter((r) => (r.finish_position as number) <= 3).length,
    top5: feature.filter((r) => (r.finish_position as number) <= 5).length,
    top10: feature.filter((r) => (r.finish_position as number) <= 10).length,
    dnfs: results.filter((r) => r.dnf).length,
    fastest_laps: results.filter((r) => r.fastest_lap).length,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { driverId: string } }
) {
  const supabase = getSupabase();
  const driverId = params.driverId;

  const { data: results, error } = await supabase
    .schema("pitboss")
    .from("results")
    .select(
      "franchise_id, finish_position, qualifying_position, dnf, fastest_lap, round_id"
    )
    .eq("driver_id", driverId)
    .returns<ResultRow[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // results.round_id has no FK to rise_os.calendar_rounds (different schema,
  // no constraint), so PostgREST can't embed it — fetch separately instead,
  // same pattern as the franchises lookup below.
  const roundIds = Array.from(
    new Set((results ?? []).map((r) => r.round_id).filter(Boolean))
  ) as string[];

  let sprintRoundIds = new Set<string>();
  if (roundIds.length > 0) {
    const { data: rounds, error: roundErr } = await supabase
      .schema("rise_os")
      .from("calendar_rounds")
      .select("id, is_sprint")
      .in("id", roundIds);

    if (roundErr) {
      return NextResponse.json({ error: roundErr.message }, { status: 500 });
    }
    sprintRoundIds = new Set(
      (rounds ?? []).filter((r) => r.is_sprint === true).map((r) => r.id as string)
    );
  }

  const hasResults = (results ?? []).length > 0;
  const stats = summarize(results ?? [], sprintRoundIds);

  let teamFranchiseIds: string[] = [];
  let teamsSource: "results" | "contract" | "none" = "none";

  if (hasResults) {
    teamFranchiseIds = Array.from(
      new Set((results ?? []).map((r) => r.franchise_id).filter(Boolean))
    ) as string[];
    teamsSource = teamFranchiseIds.length > 0 ? "results" : "none";
  } else {
    const { data: contracts, error: contractErr } = await supabase
      .schema("pitboss")
      .from("driver_contracts")
      .select("franchise_id")
      .eq("driver_id", driverId);

    if (contractErr) {
      return NextResponse.json({ error: contractErr.message }, { status: 500 });
    }

    teamFranchiseIds = Array.from(
      new Set((contracts ?? []).map((c) => c.franchise_id).filter(Boolean))
    ) as string[];
    teamsSource = teamFranchiseIds.length > 0 ? "contract" : "none";
  }

  let franchises: FranchiseRow[] = [];
  if (teamFranchiseIds.length > 0) {
    const { data, error: fErr } = await supabase
      .schema("rise_os")
      .from("franchises")
      .select("id, name, abbreviation, logo_url, primary_color")
      .in("id", teamFranchiseIds);

    if (fErr) {
      return NextResponse.json({ error: fErr.message }, { status: 500 });
    }
    franchises = data ?? [];
  }

  const teams = franchises.map((f) => ({
    franchise_id: f.id,
    name: f.name,
    abbreviation: f.abbreviation,
    logo_url: f.logo_url,
    primary_color: f.primary_color,
    source: teamsSource === "contract" ? ("contract" as const) : ("results" as const),
  }));

  return NextResponse.json(
    {
      stats,
      teams,
      teams_source: teamsSource,
      has_results: hasResults,
    },
    { headers: { "Cache-Control": "no-store, must-revalidate" } }
  );
}
