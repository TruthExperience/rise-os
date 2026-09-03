// ddv.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

type DriverMatch = {
  id: string;
  displayName: string;
  discordId: string;
};

type TeamMatch = {
  id: string;
  teamName: string;
};

// Driver options are Discord user mentions (type 6) throughout this
// codebase (contract_view, roster_assign, sign-driver) — not free-text
// name search like cap_edit's franchise option. Resolve by discord_id,
// then confirm league membership via driver_leagues.
async function resolveDriverByDiscordId(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  discordUserId: string
): Promise<{ driver?: DriverMatch; error?: string }> {
  const { data: driver, error } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id, display_name, discord_username, discord_id")
    .eq("discord_id", discordUserId)
    .maybeSingle();

  if (error) {
    console.error("[ddv] driver lookup failed:", error);
    return { error: `Couldn't look up that driver: ${error.message}` };
  }
  if (!driver) {
    return { error: `No PitBoss driver record found for <@${discordUserId}>.` };
  }

  const { data: membership, error: membershipError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("driver_id")
    .eq("driver_id", driver.id)
    .eq("league_id", leagueId)
    .maybeSingle();

  if (membershipError) {
    console.error("[ddv] driver_leagues lookup failed:", membershipError);
    return { error: `Couldn't confirm league membership: ${membershipError.message}` };
  }
  if (!membership) {
    return {
      error: `${driver.display_name ?? driver.discord_username ?? "That driver"} isn't a member of this league.`,
    };
  }

  return {
    driver: {
      id: driver.id,
      displayName: driver.display_name ?? driver.discord_username ?? "Unknown Driver",
      discordId: driver.discord_id,
    },
  };
}

// TP is per-team, scoped by team_rosters (car_class_team_id + league_id +
// season) — NOT rise_os.franchises.gm_id, and NOT driver_leagues.is_team_principal
// (that's the global per-league role flag requireLeagueOwner checks below; a
// driver can hold that role without being any specific team's TP this season).
async function resolveTeamByName(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  teamName: string
): Promise<{ team?: TeamMatch; error?: string }> {
  const { data: rosterRow, error } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("car_class_team_id, car_class_teams!inner(id, team_name)")
    .eq("league_id", leagueId)
    .ilike("car_class_teams.team_name", `%${teamName}%`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[tp_view] team lookup failed:", error);
    return { error: `Couldn't look up that team: ${error.message}` };
  }
  if (!rosterRow) {
    return { error: `No team matching "${teamName}" found in this league.` };
  }

  const team = (rosterRow as any).car_class_teams;
  return { team: { id: team.id, teamName: team.team_name } };
}

async function resolveCurrentSeason(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("season")
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data.season;
}

// Gated on driver_leagues.is_owner / is_co_owner, matching the
// requireLeagueOwner() convention already used by cap_edit and
// kick/ban/lockdown. Deliberately not leagues.commissioner_id — that
// field is unpopulated for several leagues (TRL, WSC, AARL, Halo) and
// isn't what the rest of the app actually gates on.
async function requireLeagueOwner(ctx: {
  leagueId: string;
  discordUserId: string;
}): Promise<string | null> {
  const supabase = createAdminClient();
  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();

  if (!driver) return "Only the league owner or co-owner can do that.";

  const { data: role } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("is_owner, is_co_owner")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (!role?.is_owner && !role?.is_co_owner) {
    return "Only the league owner or co-owner can do that.";
  }
  return null;
}

// TP can view DDV for drivers on their own team roster (current season) —
// narrower than requireLeagueOwner: TP status is per-team (team_rosters),
// not the league-wide owner/co-owner role.
async function isTeamPrincipalOfDriver(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  requesterDiscordId: string,
  targetDriverId: string
): Promise<boolean> {
  const { data: requester } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", requesterDiscordId)
    .maybeSingle();
  if (!requester) return false;

  const season = await resolveCurrentSeason(supabase, leagueId);
  if (!season) return false;

  const { data: tpTeams } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("car_class_team_id")
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("driver_id", requester.id)
    .eq("is_team_principal", true);

  if (!tpTeams || tpTeams.length === 0) return false;
  const teamIds = tpTeams.map((r) => r.car_class_team_id);

  const { data: targetOnTeam } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("driver_id")
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("driver_id", targetDriverId)
    .in("car_class_team_id", teamIds)
    .maybeSingle();

  return !!targetOnTeam;
}

function fmtDDV(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US")} $TRL`;
}

registerCommand("ddv_view", async (ctx) => {
  const supabase = createAdminClient();
  // Defaults to yourself, matching contract_view's convention.
  const targetDiscordId = (ctx.options.driver as string | undefined) ?? ctx.discordUserId;

  // Looking up your own DDV is always allowed. Looking up someone else's
  // requires owner/co-owner, OR being the TP of that driver's own team.
  if (targetDiscordId !== ctx.discordUserId) {
    const ownerDenied = await requireLeagueOwner(ctx);
    if (ownerDenied) {
      const targetLookup = await resolveDriverByDiscordId(supabase, ctx.leagueId, targetDiscordId);
      const isTP =
        targetLookup.driver &&
        (await isTeamPrincipalOfDriver(supabase, ctx.leagueId, ctx.discordUserId, targetLookup.driver.id));
      if (!isTP) {
        return { content: "Only the league owner, co-owner, or that driver's Team Principal can do that.", ephemeral: true };
      }
    }
  }

  const resolved = await resolveDriverByDiscordId(supabase, ctx.leagueId, targetDiscordId);
  if (resolved.error || !resolved.driver) {
    return { content: resolved.error ?? "Couldn't resolve a driver.", ephemeral: true };
  }

  const { data: ddv, error } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv, career_peak_ddv, tier_at_calc, last_calculated_at")
    .eq("driver_id", resolved.driver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (error) {
    console.error("[ddv_view] lookup failed:", error);
    return { content: `Couldn't load DDV: ${error.message}`, ephemeral: true };
  }
  if (!ddv) {
    return {
      content: `${resolved.driver.displayName} has no DDV record yet in this league.`,
      ephemeral: true,
    };
  }

  const lines = [
    `**${resolved.driver.displayName}** — Dynamic Driver Value`,
    `Current: ${fmtDDV(Number(ddv.current_ddv))} | Career Peak: ${fmtDDV(Number(ddv.career_peak_ddv))}`,
    `Tier at last calc: ${ddv.tier_at_calc ?? "—"}`,
  ];

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("ddv_edit", async (ctx) => {
  const denied = await requireLeagueOwner(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const targetDiscordId = ctx.options.driver as string | undefined;
  const amount = ctx.options.ddv as number | undefined;
  const reason = ctx.options.reason as string | undefined;

  if (!targetDiscordId) {
    return { content: "Specify a driver.", ephemeral: true };
  }
  if (amount === undefined || amount < 0) {
    return { content: "Specify a valid DDV amount.", ephemeral: true };
  }
  if (!reason || reason.trim().length === 0) {
    return { content: "A reason is required for manual DDV adjustments.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const resolved = await resolveDriverByDiscordId(supabase, ctx.leagueId, targetDiscordId);
  if (resolved.error || !resolved.driver) {
    return { content: resolved.error ?? "Couldn't resolve a driver.", ephemeral: true };
  }

  const { data: existing } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv")
    .eq("driver_id", resolved.driver.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();

  if (!existing) {
    return {
      content: `${resolved.driver.displayName} doesn't have a DDV record yet in this league — it's created by PitBoss at the next race weekend calc, not editable before then.`,
      ephemeral: true,
    };
  }

  const previousDDV = Number(existing.current_ddv);

  const { data: updated, error } = await supabase
    .schema("pitboss")
    .rpc("admin_adjust_ddv", {
      p_driver_id: resolved.driver.id,
      p_league_id: ctx.leagueId,
      p_new_ddv: amount,
      p_reason: reason,
      p_actor_discord_id: ctx.discordUserId,
    })
    .single();

  if (error) {
    console.error("[ddv_edit] rpc failed:", error);
    return { content: `Couldn't update DDV: ${error.message}`, ephemeral: true };
  }

  const newDDV = Number(updated.current_ddv);
  const clampedNote = newDDV !== amount ? ` (clamped to the $1M–$150M DDV range)` : "";

  return {
    content: `Updated **${resolved.driver.displayName}**'s DDV: ${fmtDDV(previousDDV)} → ${fmtDDV(newDDV)}${clampedNote}.\nReason: ${reason}`,
    ephemeral: false,
  };
});

registerCommand("tp_view", async (ctx) => {
  const supabase = createAdminClient();
  const teamName = ctx.options.team as string | undefined;
  const season = (ctx.options.season as string | undefined) ?? (await resolveCurrentSeason(supabase, ctx.leagueId));

  if (!season) {
    return { content: "No team rosters found for this league yet.", ephemeral: true };
  }

  // Single team: resolve team, list its TP(s) for the season.
  if (teamName) {
    const resolved = await resolveTeamByName(supabase, ctx.leagueId, teamName);
    if (resolved.error || !resolved.team) {
      return { content: resolved.error ?? "Couldn't resolve a team.", ephemeral: true };
    }

    const { data: tps, error } = await supabase
      .schema("pitboss")
      .from("team_rosters")
      .select("driver_id, drivers!inner(display_name, discord_username)")
      .eq("league_id", ctx.leagueId)
      .eq("car_class_team_id", resolved.team.id)
      .eq("season", season)
      .eq("is_team_principal", true);

    if (error) {
      console.error("[tp_view] tp lookup failed:", error);
      return { content: `Couldn't load TP: ${error.message}`, ephemeral: true };
    }
    if (!tps || tps.length === 0) {
      return {
        content: `**${resolved.team.teamName}** has no Team Principal set for season ${season}.`,
        ephemeral: true,
      };
    }

    const names = tps.map((r) => (r as any).drivers.display_name ?? (r as any).drivers.discord_username).join(", ");
    return { content: `**${resolved.team.teamName}** TP (${season}): ${names}`, ephemeral: true };
  }

  // No team given: list every team's TP for the season.
  const { data: rows, error } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("car_class_teams!inner(team_name), drivers!inner(display_name, discord_username)")
    .eq("league_id", ctx.leagueId)
    .eq("season", season)
    .eq("is_team_principal", true)
    .order("team_name", { referencedTable: "car_class_teams" });

  if (error) {
    console.error("[tp_view] league tp lookup failed:", error);
    return { content: `Couldn't load TPs: ${error.message}`, ephemeral: true };
  }
  if (!rows || rows.length === 0) {
    return { content: `No Team Principals set for season ${season}.`, ephemeral: true };
  }

  const lines = [`**Team Principals — Season ${season}**`];
  for (const row of rows as any[]) {
    const name = row.drivers.display_name ?? row.drivers.discord_username ?? "Unknown";
    lines.push(`${row.car_class_teams.team_name}: ${name}`);
  }

  return { content: lines.join("\n"), ephemeral: true };
});
