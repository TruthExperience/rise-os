import { registerCommand } from "./router";
import { createAdminClient } from "@/lib/supabase/admin";
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

const EDITOR_FLAGS = [
  "is_owner",
  "is_co_owner",
  "is_commissioner",
  "is_team_principal",
] as const;

registerCommand("roster_view", async (ctx) => {
  const supabase = createAdminClient();
  const tier = ctx.options.tier as string | undefined;

  let query = supabase
    .schema("pitboss")
    .from("team_rosters")
    .select(
      "tier, is_team_principal, car_class_teams(team_name), drivers(discord_username)"
    )
    .eq("league_id", ctx.leagueId);

  if (tier) query = query.eq("tier", tier);

  const { data, error } = await query;
  if (error || !data) {
    return { content: "Couldn't load the roster right now.", ephemeral: true };
  }
  if (data.length === 0) {
    return {
      content: tier
        ? `No roster found for ${tier}.`
        : "No roster found for this league.",
      ephemeral: true,
    };
  }

  const byTeam: Record<string, string[]> = {};
  for (const row of data as any[]) {
    const teamName = row.car_class_teams?.team_name ?? "Unknown team";
    const driverName = row.drivers?.discord_username ?? "Unknown driver";
    const label = row.is_team_principal ? `${driverName} (TP)` : driverName;
    byTeam[teamName] = byTeam[teamName] ?? [];
    byTeam[teamName].push(label);
  }

  const lines = Object.entries(byTeam)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, drivers]) => `**${team}**: ${drivers.join(", ")}`);

  return { content: lines.join("\n"), ephemeral: false };
});

registerCommand("roster_assign", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
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
      return {
        content: "Couldn't create a driver record for that user.",
        ephemeral: true,
      };
    }
    driver = created;
  }

  await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .upsert(
      {
        driver_id: driver.id,
        league_id: ctx.leagueId,
        is_driver: true,
        is_team_principal: isTP,
      },
      { onConflict: "driver_id,league_id" }
    );

  const { error: rosterError } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .upsert(
      {
        driver_id: driver.id,
        league_id: ctx.leagueId,
        car_class_team_id: teamId,
        tier,
        season,
        is_team_principal: isTP,
      },
      { onConflict: "driver_id,league_id,season" }
    );

  if (rosterError) {
    return {
      content: "Something went wrong saving the roster assignment.",
      ephemeral: true,
    };
  }

  return {
    content: `Assigned <@${targetDiscordId}> to **${teamName}** (${tier}, ${season})${
      isTP ? " as Team Principal" : ""
    }.`,
    ephemeral: false,
  };
});

registerCommand("roster_remove", async (ctx) => {
  const membership = await getLeagueMembership(ctx.discordUserId, ctx.leagueId);
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
    .eq("league_id", ctx.leagueId)
    .eq("season", season);

  if (error) {
    return {
      content: "Something went wrong removing that driver from the roster.",
      ephemeral: true,
    };
  }

  return {
    content: `Removed <@${targetDiscordId}> from the roster for ${season}.`,
    ephemeral: false,
  };
});
