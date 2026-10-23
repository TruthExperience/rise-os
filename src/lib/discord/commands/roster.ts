import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import { getLeagueMembership, hasAnyFlag } from "../permissions";

// All four racing leagues (TRL/WSC/SRH/AARL) share the F1_2026 car
// class/team set as of July 2026. If a league later runs a
// different game/season, this needs to become a per-league lookup
// instead of a constant.
const F1_2026_CAR_CLASS_ID = "3cbbd45c-7a2e-4501-8f51-a6b5f6b33326";

async function getTeamId(teamName: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .schema("pitboss")
    .from("car_class_teams")
    .select("id")
    .eq("car_class_id", F1_2026_CAR_CLASS_ID)
    .eq("team_name", teamName)
    .maybeSingle();
  return data?.id ?? null;
}

// --- franchise_rosters mirroring -------------------------------------------
// roster_assign/roster_remove write pitboss.team_rosters (car_class_teams
// reference data). Everything league-scoped (roster_view, cap, check-in,
// grid generation, /sign-driver) reads pitboss.franchise_rosters instead, so
// a driver placed with roster_assign was invisible to all of it. These two
// helpers keep franchise_rosters in step. They are best-effort: the
// team_rosters write is already done by the time they run, so a failure here
// is reported back to the caller rather than thrown.

function seasonDigits(raw: string): string {
  const m = raw.match(/\d+/);
  return m ? m[0] : raw.trim();
}

async function resolveFranchiseByTeamName(
  leagueId: string,
  teamName: string
): Promise<
  | { franchise: { id: string; name: string; division: string | null } }
  | { error: string }
> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name, abbreviation, division")
    .eq("league_id", leagueId);
  if (error) return { error: error.message };

  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(teamName);
  const rows = (data ?? []) as {
    id: string;
    name: string;
    abbreviation: string | null;
    division: string | null;
  }[];

  let matches = rows.filter((f) => norm(f.name) === target);
  if (matches.length === 0) {
    matches = rows.filter((f) => {
      const n = norm(f.name);
      return n.includes(target) || target.includes(n);
    });
  }
  if (matches.length === 0) {
    return { error: `no franchise in this league matches "${teamName}"` };
  }
  if (matches.length > 1) {
    const names = matches.map((f) => `${f.name} (${f.division ?? "no division"})`).join(", ");
    return { error: `"${teamName}" matches more than one franchise: ${names}` };
  }
  return { franchise: matches[0] };
}

async function mirrorAssignToFranchiseRosters(params: {
  leagueId: string;
  driverId: string;
  teamName: string;
  tier: string;
  season: string;
  createdBy: string;
}): Promise<{ error: string } | { ok: true }> {
  const resolved = await resolveFranchiseByTeamName(params.leagueId, params.teamName);
  if ("error" in resolved) return { error: resolved.error };
  const franchise = resolved.franchise;
  const season = seasonDigits(params.season);

  const supabase = createAdminClient();
  const { data: active, error: activeErr } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("id")
    .eq("driver_id", params.driverId)
    .eq("league_id", params.leagueId)
    .is("released_at", null)
    .maybeSingle();
  if (activeErr) return { error: activeErr.message };

  if (active) {
    const { error } = await supabase
      .schema("pitboss")
      .from("franchise_rosters")
      .update({
        franchise_id: franchise.id,
        division: franchise.division,
        season,
        tier: params.tier || null,
      })
      .eq("id", active.id);
    return error ? { error: error.message } : { ok: true };
  }

  const { error } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .insert({
      driver_id: params.driverId,
      franchise_id: franchise.id,
      league_id: params.leagueId,
      division: franchise.division,
      season,
      tier: params.tier || null,
      source: "discord:/roster_assign",
      created_by: params.createdBy,
    });
  return error ? { error: error.message } : { ok: true };
}

async function mirrorRemoveToFranchiseRosters(params: {
  leagueId: string;
  driverId: string;
  season: string;
}): Promise<{ error: string } | { released: number }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .update({
      released_at: new Date().toISOString(),
      released_reason: "discord:/roster_remove",
    })
    .eq("driver_id", params.driverId)
    .eq("league_id", params.leagueId)
    .eq("season", seasonDigits(params.season))
    .is("released_at", null)
    .select("id");
  if (error) return { error: error.message };
  return { released: data?.length ?? 0 };
}

const EDITOR_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
  "is_head_steward",
  "is_steward",
] as const;

// roster_view was previously reading pitboss.team_rosters, joined to
// pitboss.car_class_teams for the team name. car_class_teams has no
// league_id and no FK to rise_os.franchises — it's purely reference
// data for setup-generation physics (aero_efficiency, engine_power,
// etc.), keyed by a shared car class across all four leagues. It has
// nothing to do with who's actually signed to a franchise.
//
// The real, league-scoped roster data (what /sign-driver and
// /release-driver read and write) lives in pitboss.franchise_rosters,
// pointing at rise_os.franchises. That's the source of truth this
// should have been reading all along — team_rosters/car_class_teams
// stay untouched for their actual purpose (setup generation).
registerCommand("roster_view", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const tier = ctx.options.tier as string | undefined;

  let rosterQuery = supabase
    .schema("pitboss")
    .from("franchise_rosters")
    .select("driver_id, franchise_id, tier, season")
    .eq("league_id", leagueId)
    .is("released_at", null);

  if (tier) rosterQuery = rosterQuery.eq("tier", tier);

  const { data: rosterRows, error: rosterError } = await rosterQuery;
  if (rosterError || !rosterRows) {
    console.error("[roster_view] franchise_rosters query failed:", rosterError);
    return {
      content: `Couldn't load the roster right now: ${rosterError?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }
  if (rosterRows.length === 0) {
    return {
      content: tier
        ? `No roster found for tier "${tier}".`
        : "No roster found for this league.",
      ephemeral: true,
    };
  }

  const franchiseIds = [...new Set(rosterRows.map((r) => r.franchise_id))];
  const driverIds = [...new Set(rosterRows.map((r) => r.driver_id))];

  const [{ data: franchises, error: franchiseErr }, { data: drivers, error: driverErr }, { data: memberships }] =
    await Promise.all([
      supabase.schema("rise_os").from("franchises").select("id, name").in("id", franchiseIds),
      supabase.schema("pitboss").from("drivers").select("id, discord_username").in("id", driverIds),
      supabase
        .schema("pitboss")
        .from("driver_leagues")
        .select("driver_id, is_team_principal")
        .eq("league_id", leagueId)
        .in("driver_id", driverIds),
    ]);

  if (franchiseErr || driverErr) {
    console.error("[roster_view] lookup failed:", franchiseErr ?? driverErr);
    return {
      content: `Couldn't load roster details: ${(franchiseErr ?? driverErr)?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  const franchiseNameById = new Map((franchises ?? []).map((f) => [f.id, f.name]));
  const driverNameById = new Map((drivers ?? []).map((d) => [d.id, d.discord_username ?? "Unknown driver"]));
  const isTpByDriverId = new Map((memberships ?? []).map((m) => [m.driver_id, !!m.is_team_principal]));

  const byTeam: Record<string, string[]> = {};
  for (const row of rosterRows) {
    const teamName = franchiseNameById.get(row.franchise_id) ?? "Unknown franchise";
    const driverName = driverNameById.get(row.driver_id) ?? "Unknown driver";
    const label = isTpByDriverId.get(row.driver_id) ? `${driverName} (TP)` : driverName;
    byTeam[teamName] = byTeam[teamName] ?? [];
    byTeam[teamName].push(label);
  }

  const lines = Object.entries(byTeam)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, driverList]) => `**${team}**: ${driverList.join(", ")}`);

  return { content: lines.join("\n"), ephemeral: false };
});

// NOTE: roster_assign / roster_remove still write pitboss.team_rosters
// (via car_class_teams), and now also mirror into pitboss.franchise_rosters
// (see the helpers above) so roster_view, cap, check-in and grid generation
// see those drivers. They do NOT create driver_contracts or touch franchise
// wallets — /sign-driver remains the path for cap/economy-aware signings.

registerCommand("roster_assign", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return {
      content: "You don't have permission to edit the roster.",
      ephemeral: true,
    };
  }

  const targetDiscordId = ctx.options.driver as string;
  const teamName = ctx.options.team as string;
  const tier = (ctx.options.tier as string) ?? "Tier 1";
  const season = (ctx.options.season as string) ?? "S2";
  const isTP = (ctx.options.principal as boolean) ?? false;
  const resolvedUsername = ctx.resolvedUsers[targetDiscordId]?.username;

  const teamId = await getTeamId(teamName);
  if (!teamId) {
    return {
      content: `Couldn't find team "${teamName}" for this league's car class.`,
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();

  let { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", targetDiscordId)
    .maybeSingle();

  if (!driver) {
    const { data: created, error: createError } = await supabase
      .schema("pitboss")
      .from("drivers")
      .insert({
        discord_id: targetDiscordId,
        discord_username: resolvedUsername ?? targetDiscordId,
      })
      .select("id")
      .single();
    if (createError || !created) {
      console.error("[roster_assign] driver creation failed:", createError);
      return {
        content: `Couldn't create a driver record for that user: ${createError?.message ?? "unknown error"}`,
        ephemeral: true,
      };
    }
    driver = created;
  }

  const { error: membershipError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .upsert(
      {
        driver_id: driver.id,
        league_id: leagueId,
        is_driver: true,
        is_team_principal: isTP,
      },
      { onConflict: "driver_id,league_id" }
    );

  if (membershipError) {
    console.error("[roster_assign] driver_leagues upsert failed:", membershipError);
    return {
      content: `Something went wrong linking the driver to this league: ${membershipError.message}`,
      ephemeral: true,
    };
  }

  const { error: rosterError } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .upsert(
      {
        driver_id: driver.id,
        league_id: leagueId,
        car_class_team_id: teamId,
        tier,
        season,
        is_team_principal: isTP,
      },
      { onConflict: "driver_id,league_id,season" }
    );

  if (rosterError) {
    console.error("[roster_assign] team_rosters upsert failed:", rosterError);
    return {
      content: `Something went wrong saving the roster assignment: ${rosterError.message}`,
      ephemeral: true,
    };
  }

  const mirror = await mirrorAssignToFranchiseRosters({
    leagueId,
    driverId: driver.id,
    teamName,
    tier,
    season,
    createdBy: ctx.discordUserId,
  });
  let mirrorNote = "";
  if ("error" in mirror) {
    console.error("[roster_assign] franchise_rosters mirror failed:", mirror.error);
    mirrorNote = `\n⚠️ Saved to the team roster, but couldn't link a franchise roster entry (${mirror.error}). Use /sign-driver for this driver instead.`;
  }

  return {
    content: `Assigned <@${targetDiscordId}> to **${teamName}** (${tier}, ${season})${
      isTP ? " as Team Principal" : ""
    }.${mirrorNote}`,
    ephemeral: false,
  };
});

registerCommand("roster_remove", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const membership = await getLeagueMembership(ctx.discordUserId, leagueId);
  if (!hasAnyFlag(membership, [...EDITOR_FLAGS])) {
    return {
      content: "You don't have permission to edit the roster.",
      ephemeral: true,
    };
  }

  const targetDiscordId = ctx.options.driver as string;
  const season = (ctx.options.season as string) ?? "S2";

  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", targetDiscordId)
    .maybeSingle();

  if (!driver) {
    return { content: "That driver isn't on file.", ephemeral: true };
  }

  const { error } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .delete()
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .eq("season", season);

  if (error) {
    console.error("[roster_remove] delete failed:", error);
    return {
      content: `Something went wrong removing that driver from the roster: ${error.message}`,
      ephemeral: true,
    };
  }

  const mirror = await mirrorRemoveToFranchiseRosters({
    leagueId,
    driverId: driver.id,
    season,
  });
  let mirrorNote = "";
  if ("error" in mirror) {
    console.error("[roster_remove] franchise_rosters release failed:", mirror.error);
    mirrorNote = `\n⚠️ Removed from the team roster, but the franchise roster entry couldn't be released (${mirror.error}).`;
  }

  return {
    content: `Removed <@${targetDiscordId}> from the roster for ${season}.${mirrorNote}`,
    ephemeral: false,
  };
});
