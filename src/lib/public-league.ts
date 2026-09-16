import { createAdminClient } from "@/lib/supabase/server";

/**
 * Public-page data access.
 *
 * These functions run server-side only (Server Components / route handlers),
 * using the admin client to bypass RLS deliberately — RLS on driver_standings,
 * results, and calendar_rounds is scoped to league members, not the public.
 * Rather than add public SELECT policies (which would widen anon access
 * platform-wide), these functions are the enforcement boundary instead:
 * every query is hard-scoped to a single is_public=true league, and only
 * non-sensitive columns are selected. Never import createAdminClient into
 * anything that isn't this trusted, narrowly-scoped read path — nothing here
 * should ever accept unscoped input or select from franchise/contract/
 * financial tables.
 */

export type PublicLeagueSummary = {
  id: string;
  name: string;
  slug: string;
  sport: string;
  logoUrl: string | null;
  seasonCount: number;
  pitbossStatus: string;
};

export async function getPublicLeagues(): Promise<PublicLeagueSummary[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug, sport, logo_url, season_count, pitboss_status")
    .eq("is_public", true)
    .neq("pitboss_status", "inactive")
    .order("name");

  if (error) throw error;

  return (data ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    slug: l.slug,
    sport: l.sport,
    logoUrl: l.logo_url,
    seasonCount: l.season_count ?? 0,
    pitbossStatus: l.pitboss_status ?? "active",
  }));
}

export type PublicLeagueDetail = {
  league: {
    id: string;
    name: string;
    slug: string;
    sport: string;
    logoUrl: string | null;
    pitbossStatus: string;
  };
  standings: {
    driverId: string;
    points: number;
    wins: number;
    top3: number;
  }[];
  nextRound: {
    name: string | null;
    circuit: string | null;
    country: string | null;
    raceDate: string;
    roundNumber: number;
  } | null;
  constructorStandings: {
    franchiseId: string;
    points: number;
    wins: number;
  }[];
  rules: {
    id: string;
    articleNumber: string | null;
    title: string;
    chapter: string | null;
  }[];
};

export async function getPublicLeagueBySlug(
  slug: string,
): Promise<PublicLeagueDetail | null> {
  const supabase = createAdminClient();

  const { data: league, error: leagueError } = await supabase
    .schema("rise_os")
    .from("leagues")
    .select("id, name, slug, sport, logo_url, pitboss_status")
    .eq("slug", slug)
    .eq("is_public", true)
    .maybeSingle();

  if (leagueError) throw leagueError;
  if (!league) return null;

  const today = new Date().toISOString().slice(0, 10);

  const [standingsRes, nextRoundRes, constructorRes, rulesRes] =
    await Promise.all([
      supabase
        .schema("pitboss")
        .from("driver_standings")
        .select("driver_id, points, wins, top3")
        .eq("league_id", league.id)
        .order("points", { ascending: false })
        .limit(3),
      supabase
        .schema("rise_os")
        .from("calendar_rounds")
        .select("name, circuit, country, race_date, round_number")
        .eq("league_id", league.id)
        .gte("race_date", today)
        .order("race_date", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("pitboss")
        .from("constructor_standings")
        .select("franchise_id, points, wins")
        .eq("league_id", league.id)
        .order("points", { ascending: false })
        .limit(5),
      supabase
        .schema("pitboss")
        .from("rule_articles")
        .select("id, article_number, title, chapter")
        .eq("league_id", league.id)
        .eq("active", true)
        .eq("is_canonical", true)
        .order("sort_order")
        .limit(6),
    ]);

  if (standingsRes.error) throw standingsRes.error;
  if (nextRoundRes.error) throw nextRoundRes.error;
  if (constructorRes.error) throw constructorRes.error;
  if (rulesRes.error) throw rulesRes.error;

  return {
    league: {
      id: league.id,
      name: league.name,
      slug: league.slug,
      sport: league.sport,
      logoUrl: league.logo_url,
      pitbossStatus: league.pitboss_status ?? "active",
    },
    standings: (standingsRes.data ?? []).map((s) => ({
      driverId: s.driver_id,
      points: Number(s.points),
      wins: s.wins,
      top3: s.top3,
    })),
    nextRound: nextRoundRes.data
      ? {
          name: nextRoundRes.data.name,
          circuit: nextRoundRes.data.circuit,
          country: nextRoundRes.data.country,
          raceDate: nextRoundRes.data.race_date,
          roundNumber: nextRoundRes.data.round_number,
        }
      : null,
    constructorStandings: (constructorRes.data ?? []).map((c) => ({
      franchiseId: c.franchise_id,
      points: Number(c.points),
      wins: c.wins,
    })),
    rules: (rulesRes.data ?? []).map((r) => ({
      id: r.id,
      articleNumber: r.article_number,
      title: r.title,
      chapter: r.chapter,
    })),
  };
}
