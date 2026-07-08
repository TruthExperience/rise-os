import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const ESPN_TEAMS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams";

type EspnTeam = { id: string; displayName: string; nickname?: string };

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function fetchEspnTeams(groups: number): Promise<EspnTeam[]> {
  const res = await fetch(`${ESPN_TEAMS_URL}?groups=${groups}&limit=700`);
  if (!res.ok) throw new Error(`ESPN teams fetch failed: ${res.status}`);
  const json = await res.json();
  const list = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return list.map((t: any) => ({
    id: t.team.id,
    displayName: t.team.displayName,
    nickname: t.team.nickname,
  }));
}

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function similarity(a: string, b: string) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  return 0;
}

// GET: return suggested matches for unmatched franchises
export async function GET() {
  const supabase = getSupabase();
  const [fbs, fcs] = await Promise.all([fetchEspnTeams(80), fetchEspnTeams(81)]);
  const espnTeams = [...fbs, ...fcs];

  const { data: franchises, error } = await supabase
    .from("franchises")
    .select("id, name, abbreviation, espn_team_id")
    .is("espn_team_id", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const suggestions = (franchises ?? []).map((f) => {
    const scored = espnTeams
      .map((t) => ({ team: t, score: similarity(f.name, t.displayName) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return {
      franchiseId: f.id,
      franchiseName: f.name,
      bestMatch: scored[0]?.team ?? null,
      confidence: scored[0]?.score ?? 0,
      alternates: scored.slice(1, 4).map((s) => s.team),
    };
  });

  return NextResponse.json({ count: suggestions.length, suggestions });
}

// POST: confirm matches -> [{ franchiseId, espnTeamId }]
export async function POST(req: NextRequest) {
  const supabase = getSupabase();
  const body = await req.json();
  const matches: { franchiseId: string; espnTeamId: number }[] = body.matches ?? [];

  const results = [];
  for (const m of matches) {
    const { error } = await supabase
      .from("franchises")
      .update({ espn_team_id: m.espnTeamId })
      .eq("id", m.franchiseId);
    results.push({ franchiseId: m.franchiseId, ok: !error, error: error?.message });
  }

  return NextResponse.json({ updated: results.filter((r) => r.ok).length, results });
}
