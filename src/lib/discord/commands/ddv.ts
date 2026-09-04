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

// Whether the caller is TP of a *specific* team (used by ddv_team when a
// team name is explicitly given, vs isTeamPrincipalOfDriver which checks
// TP status relative to a target driver).
async function isCallerTPOfTeam(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  callerDiscordId: string,
  teamId: string,
  season: string
): Promise<boolean> {
  const { data: caller } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", callerDiscordId)
    .maybeSingle();
  if (!caller) return false;

  const { data: tpRow } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("driver_id")
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("car_class_team_id", teamId)
    .eq("driver_id", caller.id)
    .eq("is_team_principal", true)
    .maybeSingle();

  return !!tpRow;
}

// Every team the caller is TP of this season — used by ddv_team when no
// `team` option is given, so it can default to "my team(s)".
async function resolveOwnTPTeams(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  callerDiscordId: string,
  season: string
): Promise<TeamMatch[]> {
  const { data: caller } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", callerDiscordId)
    .maybeSingle();
  if (!caller) return [];

  const { data: rows } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("car_class_team_id, car_class_teams!inner(id, team_name)")
    .eq("league_id", leagueId)
    .eq("season", season)
    .eq("driver_id", caller.id)
    .eq("is_team_principal", true);

  if (!rows) return [];
  return rows.map((r) => ({
    id: (r as any).car_class_teams.id,
    teamName: (r as any).car_class_teams.team_name,
  }));
}

// Leagues are inconsistently slugged: some are already abbreviations
// (trl, wsc, aarl, awc), others are full hyphenated names
// (halo-racing-league). Short slugs are used as-is; hyphenated ones
// get initialized (halo-racing-league -> HRL) to match the short-form
// convention the rest of the codebase already uses in comments/docs.
function leagueCurrencyLabel(slug: string): string {
  if (!slug.includes("-")) return slug.toUpperCase();
  return slug
    .split("-")
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function fmtDDV(n: number | null | undefined, leagueSlug: string): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US")} ${leagueCurrencyLabel(leagueSlug)}`;
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
    `Current: ${fmtDDV(Number(ddv.current_ddv), ctx.leagueSlug)} | Career Peak: ${fmtDDV(Number(ddv.career_peak_ddv), ctx.leagueSlug)}`,
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
    .single<{ current_ddv: number }>();

  if (error) {
    console.error("[ddv_edit] rpc failed:", error);
    return { content: `Couldn't update DDV: ${error.message}`, ephemeral: true };
  }

  const newDDV = Number(updated.current_ddv);
  const clampedNote = newDDV !== amount ? ` (clamped to the $1M–$150M DDV range)` : "";

  return {
    content: `Updated **${resolved.driver.displayName}**'s DDV: ${fmtDDV(previousDDV, ctx.leagueSlug)} → ${fmtDDV(newDDV, ctx.leagueSlug)}${clampedNote}.\nReason: ${reason}`,
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

  const lines = [`**Team Principals (${season})**`];
  rows.forEach((row) => {
    const teamName = (row as any).car_class_teams.team_name;
    const driverName = (row as any).drivers.display_name ?? (row as any).drivers.discord_username ?? "Unknown";
    lines.push(`${teamName} — ${driverName}`);
  });

  return { content: lines.join("\n"), ephemeral: true };
});

// A TP's roster-wide DDV view. Defaults to whichever team(s) the caller is
// TP of this season; an explicit `team` option lets a league owner/co-owner
// (or that team's own TP) look up any team. Mirrors tp_view's team-name
// resolution and requireLeagueOwner/isCallerTPOfTeam's gating pattern.
registerCommand("ddv_team", async (ctx) => {
  const supabase = createAdminClient();
  const teamNameOption = ctx.options.team as string | undefined;
  const season = (ctx.options.season as string | undefined) ?? (await resolveCurrentSeason(supabase, ctx.leagueId));

  if (!season) {
    return { content: "No team rosters found for this league yet.", ephemeral: true };
  }

  let targetTeam: TeamMatch | undefined;

  if (teamNameOption) {
    const resolved = await resolveTeamByName(supabase, ctx.leagueId, teamNameOption);
    if (resolved.error || !resolved.team) {
      return { content: resolved.error ?? "Couldn't resolve a team.", ephemeral: true };
    }
    targetTeam = resolved.team;

    const ownerDenied = await requireLeagueOwner(ctx);
    if (ownerDenied) {
      const isTP = await isCallerTPOfTeam(supabase, ctx.leagueId, ctx.discordUserId, targetTeam.id, season);
      if (!isTP) {
        return {
          content: "Only the league owner, co-owner, or this team's Team Principal can view team DDV.",
          ephemeral: true,
        };
      }
    }
  } else {
    const ownTeams = await resolveOwnTPTeams(supabase, ctx.leagueId, ctx.discordUserId, season);
    if (ownTeams.length === 0) {
      return {
        content: "You aren't set as Team Principal for any team this season. Specify a `team` to view a different one.",
        ephemeral: true,
      };
    }
    if (ownTeams.length > 1) {
      return {
        content: `You're TP of multiple teams this season: ${ownTeams
          .map((t) => t.teamName)
          .join(", ")}. Specify which one with the \`team\` option.`,
        ephemeral: true,
      };
    }
    targetTeam = ownTeams[0];
  }

  const { data: roster, error: rosterError } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("driver_id, drivers!inner(display_name, discord_username)")
    .eq("league_id", ctx.leagueId)
    .eq("car_class_team_id", targetTeam.id)
    .eq("season", season);

  if (rosterError) {
    console.error("[ddv_team] roster lookup failed:", rosterError);
    return { content: `Couldn't load the roster: ${rosterError.message}`, ephemeral: true };
  }
  if (!roster || roster.length === 0) {
    return {
      content: `**${targetTeam.teamName}** has no drivers signed for season ${season}.`,
      ephemeral: true,
    };
  }

  const driverIds = roster.map((r) => r.driver_id);

  const { data: ddvRows, error: ddvError } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("driver_id, current_ddv, tier_at_calc")
    .eq("league_id", ctx.leagueId)
    .in("driver_id", driverIds);

  if (ddvError) {
    console.error("[ddv_team] ddv lookup failed:", ddvError);
    return { content: `Couldn't load DDV: ${ddvError.message}`, ephemeral: true };
  }

  const ddvByDriver = new Map((ddvRows ?? []).map((r) => [r.driver_id, r]));

  const lines = [`**${targetTeam.teamName}** — Team DDV (${season})`];
  let total = 0;
  roster.forEach((r) => {
    const name = (r as any).drivers.display_name ?? (r as any).drivers.discord_username ?? "Unknown";
    const ddv = ddvByDriver.get(r.driver_id);
    if (ddv) {
      total += Number(ddv.current_ddv);
      lines.push(`${name} — ${fmtDDV(Number(ddv.current_ddv), ctx.leagueSlug)} (Tier: ${ddv.tier_at_calc ?? "—"})`);
    } else {
      lines.push(`${name} — no DDV record yet`);
    }
  });
  lines.push(`**Team Total:** ${fmtDDV(total, ctx.leagueSlug)}`);

  return { content: lines.join("\n"), ephemeral: true };
});

// Open to any league member (not gated to owner/co-owner like ddv_view's
// other-driver lookup) — this is a league-wide read, not a single driver's
// private-ish record.
registerCommand("ddv_leaderboard", async (ctx) => {
  const supabase = createAdminClient();

  const { data: requester } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();
  if (!requester) {
    return { content: "No PitBoss driver record found for you.", ephemeral: true };
  }

  const { data: membership } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("driver_id")
    .eq("driver_id", requester.id)
    .eq("league_id", ctx.leagueId)
    .maybeSingle();
  if (!membership) {
    return { content: "You aren't a member of this league.", ephemeral: true };
  }

  const { data: rows, error } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv, drivers!inner(display_name, discord_username)")
    .eq("league_id", ctx.leagueId)
    .order("current_ddv", { ascending: false });

  if (error) {
    console.error("[ddv_leaderboard] lookup failed:", error);
    return { content: `Couldn't load DDV leaderboard: ${error.message}`, ephemeral: true };
  }
  if (!rows || rows.length === 0) {
    return { content: "No DDV records found for this league yet.", ephemeral: true };
  }

  const lines = ["**DDV Leaderboard**"];
  rows.forEach((row, i) => {
    const name = (row as any).drivers.display_name ?? (row as any).drivers.discord_username ?? "Unknown";
    lines.push(`${i + 1}. ${name} — ${fmtDDV(Number(row.current_ddv), ctx.leagueSlug)}`);
  });

  return { content: lines.join("\n"), ephemeral: false };
});
