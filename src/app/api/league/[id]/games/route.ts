import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// ─── Types ──────────────────────────────────────────────────────────────────

interface FranchiseLite {
  id: string;
  name: string;
  abbreviation: string;
  logo_url: string | null;
  wins: number;
  losses: number;
}

interface GameRow {
  id: string;
  season_id: string | null;
  week: number;
  home_franchise_id: string;
  away_franchise_id: string;
  home_score: number;
  away_score: number;
  played_at: string | null;
}

interface BulkGameInput {
  season_id: string | null;
  week: number;
  home_franchise_id: string;
  away_franchise_id: string;
  home_score: number | null;
  away_score: number | null;
}

// ─── GET ────────────────────────────────────────────────────────────────────
// Returns { games, standings, weekLabels } for the league. Franchise objects
// are enriched onto each game (same pattern as /api/franchises/[leagueId]),
// since rise_os.games only stores the FK ids, not nested rows. weekLabels
// drives the week picker on the frontend (e.g. week 15 -> "Conference
// Championship") instead of raw integers — editable via rise_os.week_labels.

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = createAdminClient();

  const { data: games, error: gamesError } = await admin
    .schema("rise_os")
    .from("games")
    .select(
      "id, season_id, week, home_franchise_id, away_franchise_id, home_score, away_score, played_at"
    )
    .eq("league_id", params.id)
    .order("week", { ascending: true });

  if (gamesError) {
    return NextResponse.json({ error: gamesError.message }, { status: 500 });
  }

  const { data: standings, error: standingsError } = await admin
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, logo_url, wins, losses")
    .eq("league_id", params.id)
    .order("wins", { ascending: false });

  if (standingsError) {
    return NextResponse.json({ error: standingsError.message }, { status: 500 });
  }

  const { data: weekLabels, error: weekLabelsError } = await admin
    .schema("rise_os")
    .from("week_labels")
    .select("week, label")
    .order("week", { ascending: true });

  if (weekLabelsError) {
    return NextResponse.json({ error: weekLabelsError.message }, { status: 500 });
  }

  const franchiseMap: Record<string, FranchiseLite> = Object.fromEntries(
    ((standings ?? []) as FranchiseLite[]).map((f) => [f.id, f])
  );

  const enrichedGames = ((games ?? []) as GameRow[]).map((g) => ({
    ...g,
    home_franchise: franchiseMap[g.home_franchise_id] ?? null,
    away_franchise: franchiseMap[g.away_franchise_id] ?? null,
  }));

  return NextResponse.json({
    games: enrichedGames,
    standings: standings ?? [],
    weekLabels: weekLabels ?? [],
  });
}

// ─── POST ───────────────────────────────────────────────────────────────────
// Body: { rows: BulkGameInput[] }
//
// Bulk-inserts games for this league (used by the Bulk Add Games page).
// Same permission tiers as PUT below. For any row that already has both
// scores filled in, marks it played (played_at = now) and immediately
// applies the win/loss result to both franchises via adjustFranchiseRecord —
// mirroring what PUT does for a single edited game. Rows with one or both
// scores left null are inserted as scheduled-but-unplayed games and don't
// touch any franchise record.

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const authUser = authData?.user;

  if (!authUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("users")
    .select("id")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: "No matching user profile" }, { status: 403 });
  }

  const { data: adminRow } = await admin
    .schema("rise_os")
    .from("league_admins")
    .select("role")
    .eq("league_id", params.id)
    .eq("user_id", profile.id)
    .maybeSingle();

  let canEdit = !!adminRow;

  if (!canEdit) {
    const { data: memberRow } = await admin
      .schema("rise_os")
      .from("league_members")
      .select("role, status")
      .eq("league_id", params.id)
      .eq("user_id", profile.id)
      .eq("status", "active")
      .maybeSingle();

    canEdit =
      !!memberRow && ["coach", "co_commissioner", "admin", "commissioner"].includes(memberRow.role);
  }

  if (!canEdit) {
    return NextResponse.json(
      { error: "You don't have permission to add games in this league." },
      { status: 403 }
    );
  }

  const body = await req.json();
  const rows: BulkGameInput[] = Array.isArray(body?.rows) ? body.rows : [];

  if (rows.length === 0) {
    return NextResponse.json({ error: "rows is required and must be a non-empty array" }, { status: 400 });
  }

  for (const r of rows) {
    if (
      typeof r.week !== "number" ||
      typeof r.home_franchise_id !== "string" ||
      typeof r.away_franchise_id !== "string" ||
      !r.home_franchise_id ||
      !r.away_franchise_id
    ) {
      return NextResponse.json(
        { error: "Each row requires week, home_franchise_id, and away_franchise_id" },
        { status: 400 }
      );
    }
    if (r.home_franchise_id === r.away_franchise_id) {
      return NextResponse.json(
        { error: `Home and away team can't be the same franchise (week ${r.week})` },
        { status: 400 }
      );
    }
  }

  const now = new Date().toISOString();

  const toInsert = rows.map((r) => {
    const isPlayed = r.home_score !== null && r.away_score !== null;
    return {
      league_id: params.id,
      season_id: r.season_id,
      week: r.week,
      home_franchise_id: r.home_franchise_id,
      away_franchise_id: r.away_franchise_id,
      home_score: r.home_score,
      away_score: r.away_score,
      played_at: isPlayed ? now : null,
    };
  });

  const { data: inserted, error: insertError } = await admin
    .schema("rise_os")
    .from("games")
    .insert(toInsert)
    .select();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const playedGames = (inserted ?? []).filter(
    (g) => g.home_score !== null && g.away_score !== null
  );

  for (const g of playedGames) {
    await adjustFranchiseRecord(
      admin,
      g.home_franchise_id,
      g.away_franchise_id,
      g.home_score,
      g.away_score,
      1
    );
  }

  return NextResponse.json({ games: inserted ?? [] }, { status: 201 });
}

// ─── PUT ────────────────────────────────────────────────────────────────────
// Body: { game_id, home_score, away_score }
//
// Permission tiers:
//   - rise_os.league_admins (commissioner / co_commissioner / admin) can
//     edit any game in the league.
//   - rise_os.league_members with role in
//     [coach, co_commissioner, admin, commissioner] and status 'active' can
//     also edit — but if their role is 'coach', they're restricted to games
//     involving their own franchise (via rise_os.coaches.current_franchise_id).
//
// On save, reverses any previously-counted result for the two franchises
// (if this game was already played) and applies the new result's
// wins/losses. Ties are not counted toward either side's record.

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const authUser = authData?.user;

  if (!authUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("users")
    .select("id")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.json({ error: "No matching user profile" }, { status: 403 });
  }

  const { data: adminRow } = await admin
    .schema("rise_os")
    .from("league_admins")
    .select("role")
    .eq("league_id", params.id)
    .eq("user_id", profile.id)
    .maybeSingle();

  let canEdit = !!adminRow;
  let coachFranchiseId: string | null = null;

  if (!canEdit) {
    const { data: memberRow } = await admin
      .schema("rise_os")
      .from("league_members")
      .select("role, status")
      .eq("league_id", params.id)
      .eq("user_id", profile.id)
      .eq("status", "active")
      .maybeSingle();

    const eligibleRole =
      !!memberRow && ["coach", "co_commissioner", "admin", "commissioner"].includes(memberRow.role);

    if (eligibleRole && memberRow!.role === "coach") {
      const { data: coachRow } = await admin
        .schema("rise_os")
        .from("coaches")
        .select("current_franchise_id")
        .eq("league_id", params.id)
        .eq("user_id", profile.id)
        .maybeSingle();

      coachFranchiseId = coachRow?.current_franchise_id ?? null;
      canEdit = !!coachFranchiseId;
    } else {
      canEdit = eligibleRole;
    }
  }

  if (!canEdit) {
    return NextResponse.json(
      { error: "You don't have permission to edit games in this league." },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { game_id, home_score, away_score } = body;

  if (!game_id || typeof game_id !== "string") {
    return NextResponse.json({ error: "game_id is required" }, { status: 400 });
  }
  if (
    home_score === undefined ||
    away_score === undefined ||
    typeof home_score !== "number" ||
    typeof away_score !== "number"
  ) {
    return NextResponse.json(
      { error: "home_score and away_score must be numbers" },
      { status: 400 }
    );
  }

  const { data: existingGame, error: fetchError } = await admin
    .schema("rise_os")
    .from("games")
    .select("id, league_id, home_franchise_id, away_franchise_id, home_score, away_score, played_at")
    .eq("id", game_id)
    .eq("league_id", params.id)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!existingGame) {
    return NextResponse.json({ error: "Game not found in this league" }, { status: 404 });
  }

  if (
    coachFranchiseId &&
    existingGame.home_franchise_id !== coachFranchiseId &&
    existingGame.away_franchise_id !== coachFranchiseId
  ) {
    return NextResponse.json(
      { error: "You can only edit games involving your own franchise." },
      { status: 403 }
    );
  }

  const now = new Date().toISOString();

  const { data: updatedGame, error: updateError } = await admin
    .schema("rise_os")
    .from("games")
    .update({
      home_score,
      away_score,
      played_at: existingGame.played_at ?? now,
      updated_at: now,
    })
    .eq("id", game_id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (existingGame.played_at) {
    await adjustFranchiseRecord(
      admin,
      existingGame.home_franchise_id,
      existingGame.away_franchise_id,
      existingGame.home_score,
      existingGame.away_score,
      -1
    );
  }

  await adjustFranchiseRecord(
    admin,
    existingGame.home_franchise_id,
    existingGame.away_franchise_id,
    home_score,
    away_score,
    1
  );

  return NextResponse.json(updatedGame);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Adjusts wins/losses on the two franchises involved in a game by `delta`
 * (+1 to apply a result, -1 to reverse a previously-applied one). Ties
 * (home_score === away_score) don't move either side's record.
 */
async function adjustFranchiseRecord(
  admin: ReturnType<typeof createAdminClient>,
  homeFranchiseId: string,
  awayFranchiseId: string,
  homeScore: number,
  awayScore: number,
  delta: 1 | -1
) {
  if (homeScore === awayScore) return; // tie — no record change

  const winnerId = homeScore > awayScore ? homeFranchiseId : awayFranchiseId;
  const loserId = homeScore > awayScore ? awayFranchiseId : homeFranchiseId;

  const [{ data: winner }, { data: loser }] = await Promise.all([
    admin.schema("rise_os").from("franchises").select("wins").eq("id", winnerId).maybeSingle(),
    admin.schema("rise_os").from("franchises").select("losses").eq("id", loserId).maybeSingle(),
  ]);

  await Promise.all([
    admin
      .schema("rise_os")
      .from("franchises")
      .update({ wins: Math.max(0, (winner?.wins ?? 0) + delta) })
      .eq("id", winnerId),
    admin
      .schema("rise_os")
      .from("franchises")
      .update({ losses: Math.max(0, (loser?.losses ?? 0) + delta) })
      .eq("id", loserId),
  ]);
}
