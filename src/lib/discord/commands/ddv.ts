// ddv.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";
import {
  formatLeagueMoney,
  leagueCurrencyLabel,
  leagueCurrencySymbol,
} from "@/lib/currency";
import { buildDdvGuide } from "../ddv-guide";

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

// Money is formatted per league (see @/lib/currency): W11 is a UK league, so
// its figures render in pounds (£) rather than a "$W11" prefix.
function fmtDDV(n: number | null | undefined, leagueSlug: string): string {
  return formatLeagueMoney(n, leagueSlug);
}

registerCommand("ddv_view", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  // ctx.leagueSlug is optional on CommandContext (same refactor that made
  // leagueId/channelId optional elsewhere in this codebase) — narrow it
  // into a local before it's passed to fmtDDV, which requires a plain
  // string.
  const leagueSlug = ctx.leagueSlug;
  if (!leagueSlug) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();
  // Defaults to yourself, matching contract_view's convention.
  const targetDiscordId = (ctx.options.driver as string | undefined) ?? ctx.discordUserId;

  // Looking up your own DDV is always allowed. Looking up someone else's
  // requires owner/co-owner, OR being the TP of that driver's own team.
  if (targetDiscordId !== ctx.discordUserId) {
    const ownerDenied = await requireLeagueOwner({ leagueId, discordUserId: ctx.discordUserId });
    if (ownerDenied) {
      const targetLookup = await resolveDriverByDiscordId(supabase, leagueId, targetDiscordId);
      const isTP =
        targetLookup.driver &&
        (await isTeamPrincipalOfDriver(supabase, leagueId, ctx.discordUserId, targetLookup.driver.id));
      if (!isTP) {
        return { content: "Only the league owner, co-owner, or that driver's Team Principal can do that.", ephemeral: true };
      }
    }
  }

  const resolved = await resolveDriverByDiscordId(supabase, leagueId, targetDiscordId);
  if (resolved.error || !resolved.driver) {
    return { content: resolved.error ?? "Couldn't resolve a driver.", ephemeral: true };
  }

  const { data: ddv, error } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv, career_peak_ddv, tier_at_calc, last_calculated_at")
    .eq("driver_id", resolved.driver.id)
    .eq("league_id", leagueId)
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
    `Current: ${fmtDDV(Number(ddv.current_ddv), leagueSlug)} | Career Peak: ${fmtDDV(Number(ddv.career_peak_ddv), leagueSlug)}`,
    `Tier at last calc: ${ddv.tier_at_calc ?? "—"}`,
  ];

  return { content: lines.join("\n"), ephemeral: true };
});

registerCommand("ddv_edit", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const leagueSlug = ctx.leagueSlug;
  if (!leagueSlug) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const denied = await requireLeagueOwner({ leagueId, discordUserId: ctx.discordUserId });
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
  const resolved = await resolveDriverByDiscordId(supabase, leagueId, targetDiscordId);
  if (resolved.error || !resolved.driver) {
    return { content: resolved.error ?? "Couldn't resolve a driver.", ephemeral: true };
  }

  const { data: existing } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv")
    .eq("driver_id", resolved.driver.id)
    .eq("league_id", leagueId)
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
      p_league_id: leagueId,
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
    content: `Updated **${resolved.driver.displayName}**'s DDV: ${fmtDDV(previousDDV, leagueSlug)} → ${fmtDDV(newDDV, leagueSlug)}${clampedNote}.\nReason: ${reason}`,
    ephemeral: false,
  };
});

registerCommand("tp_view", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const teamName = ctx.options.team as string | undefined;
  const season = (ctx.options.season as string | undefined) ?? (await resolveCurrentSeason(supabase, leagueId));

  if (!season) {
    return { content: "No team rosters found for this league yet.", ephemeral: true };
  }

  // Single team: resolve team, list its TP(s) for the season.
  if (teamName) {
    const resolved = await resolveTeamByName(supabase, leagueId, teamName);
    if (resolved.error || !resolved.team) {
      return { content: resolved.error ?? "Couldn't resolve a team.", ephemeral: true };
    }

    const { data: tps, error } = await supabase
      .schema("pitboss")
      .from("team_rosters")
      .select("driver_id, drivers!inner(display_name, discord_username)")
      .eq("league_id", leagueId)
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
    .eq("league_id", leagueId)
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
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const leagueSlug = ctx.leagueSlug;
  if (!leagueSlug) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const teamNameOption = ctx.options.team as string | undefined;
  const season = (ctx.options.season as string | undefined) ?? (await resolveCurrentSeason(supabase, leagueId));

  if (!season) {
    return { content: "No team rosters found for this league yet.", ephemeral: true };
  }

  let targetTeam: TeamMatch | undefined;

  if (teamNameOption) {
    const resolved = await resolveTeamByName(supabase, leagueId, teamNameOption);
    if (resolved.error || !resolved.team) {
      return { content: resolved.error ?? "Couldn't resolve a team.", ephemeral: true };
    }
    targetTeam = resolved.team;

    const ownerDenied = await requireLeagueOwner({ leagueId, discordUserId: ctx.discordUserId });
    if (ownerDenied) {
      const isTP = await isCallerTPOfTeam(supabase, leagueId, ctx.discordUserId, targetTeam.id, season);
      if (!isTP) {
        return {
          content: "Only the league owner, co-owner, or this team's Team Principal can view team DDV.",
          ephemeral: true,
        };
      }
    }
  } else {
    const ownTeams = await resolveOwnTPTeams(supabase, leagueId, ctx.discordUserId, season);
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

  const { data: rosterRows, error: rosterError } = await supabase
    .schema("pitboss")
    .from("team_rosters")
    .select("driver_id, is_team_principal, drivers!inner(display_name, discord_username)")
    .eq("league_id", leagueId)
    .eq("car_class_team_id", targetTeam.id)
    .eq("season", season);

  if (rosterError) {
    console.error("[ddv_team] roster lookup failed:", rosterError);
    return { content: `Couldn't load the roster: ${rosterError.message}`, ephemeral: true };
  }
  if (rosterRows.length === 0) {
    return {
      content: `**${targetTeam.teamName}** has no drivers signed for season ${season}.`,
      ephemeral: true,
    };
  }

  const driverIds = rosterRows.map((r) => r.driver_id);

  const { data: ddvRows, error: ddvError } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("driver_id, current_ddv, tier_at_calc")
    .eq("league_id", leagueId)
    .in("driver_id", driverIds);

  if (ddvError) {
    console.error("[ddv_team] ddv lookup failed:", ddvError);
    return { content: `Couldn't load DDV: ${ddvError.message}`, ephemeral: true };
  }

  const ddvByDriver = new Map((ddvRows ?? []).map((r) => [r.driver_id, r]));

  // Team Principals sit on team_rosters but don't race, so they never accrue a
  // DDV. Listing them made every non-racing TP look like a driver missing a
  // DDV record — that's what put them in the missing-DDV audit. Only TP-flagged
  // drivers with no DDV are dropped: several principals do race, hold a DDV and
  // must stay in the list.
  const roster = rosterRows.filter((r) => {
    const flaggedTp = (r as { is_team_principal?: boolean }).is_team_principal === true;
    return !(flaggedTp && !ddvByDriver.has(r.driver_id));
  });

  if (roster.length === 0) {
    return {
      content: `**${targetTeam.teamName}** has no racing drivers signed for season ${season}.`,
      ephemeral: true,
    };
  }

  const lines = [`**${targetTeam.teamName}** — Team DDV (${season})`];
  let total = 0;
  roster.forEach((r) => {
    const name = (r as any).drivers.display_name ?? (r as any).drivers.discord_username ?? "Unknown";
    const ddv = ddvByDriver.get(r.driver_id);
    if (ddv) {
      total += Number(ddv.current_ddv);
      lines.push(`${name} — ${fmtDDV(Number(ddv.current_ddv), leagueSlug)} (Tier: ${ddv.tier_at_calc ?? "—"})`);
    } else {
      lines.push(`${name} — no DDV record yet`);
    }
  });
  lines.push(`**Team Total:** ${fmtDDV(total, leagueSlug)}`);

  return { content: lines.join("\n"), ephemeral: true };
});

// Open to any league member (not gated to owner/co-owner like ddv_view's
// other-driver lookup) — this is a league-wide read, not a single driver's
// private-ish record.
registerCommand("ddv_leaderboard", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const leagueSlug = ctx.leagueSlug;
  if (!leagueSlug) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

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
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!membership) {
    return { content: "You aren't a member of this league.", ephemeral: true };
  }

  const { data: rows, error } = await supabase
    .schema("pitboss")
    .from("driver_ddv")
    .select("current_ddv, drivers!inner(display_name, discord_username)")
    .eq("league_id", leagueId)
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
    lines.push(`${i + 1}. ${name} — ${fmtDDV(Number(row.current_ddv), leagueSlug)}`);
  });

  return { content: lines.join("\n"), ephemeral: false };
});

// The pinnable explainer: what moves DDV, the weekend cap, and the contract
// floor/ceiling, in under Discord's 2000-character limit. Open to everyone in
// the league (it's nobody's private figures) and posted in the channel rather
// than ephemerally so an admin can pin it. Every number comes from this
// league's league_financial_config, so it can't drift from what /sign-driver
// and /cap actually enforce.
registerCommand("ddv_guide", async (ctx) => {
  const leagueId = ctx.leagueId;
  if (!leagueId) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const leagueSlug = ctx.leagueSlug;
  if (!leagueSlug) {
    return { content: "This command must be used in a league channel.", ephemeral: true };
  }

  const supabase = createAdminClient();

  const { data: config, error } = await supabase
    .schema("pitboss")
    .from("league_financial_config")
    .select(
      "contract_floor_pct, contract_ceiling_pct, soft_cap, hard_apron, ddv_weekend_gain_cap, ddv_weekend_loss_cap, ddv_base_rate_per_bps, attendance_config"
    )
    .eq("league_id", leagueId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[ddv_guide] config lookup failed:", error);
    return { content: `Couldn't load this league's DDV config: ${error.message}`, ephemeral: true };
  }
  if (!config) {
    return {
      content:
        "This league has no DDV/financial config yet, so there's nothing to explain. Add a league_financial_config row for it first.",
      ephemeral: true,
    };
  }

  const attendance = (config.attendance_config ?? {}) as {
    noshow_pct?: number;
    decline_pct?: number;
    penalty_min?: number;
    penalty_max?: number;
    streak_bonus_cap?: number;
  };

  // The per-event money rates scale linearly with the league's DDV base rate.
  // These multiples were measured against W11 T1's real engine output at its
  // base rate of 15,000 (race point ≈ 21,000, quali place ≈ 9,000, sprint
  // point ≈ 15,000, head-to-head ≈ ±337,500, clean weekend +12,000, penalty
  // point ≈ −6,000), so another league's figures follow its own rate instead
  // of borrowing W11's numbers.
  const baseRate = Number(config.ddv_base_rate_per_bps ?? 15000);
  const per = (multiple: number) => Math.round((baseRate * multiple) / 500) * 500;

  const content = buildDdvGuide({
    money: (n) => formatLeagueMoney(n, leagueSlug, { withLabel: false }),
    currencyName: `${leagueCurrencyLabel(leagueSlug)} (${leagueCurrencySymbol(leagueSlug)})`,
    floorPct: Number(config.contract_floor_pct),
    ceilingPct: Number(config.contract_ceiling_pct),
    softCap: Number(config.soft_cap),
    apron: Number(config.hard_apron),
    gainCap: Number(config.ddv_weekend_gain_cap),
    lossCap: Number(config.ddv_weekend_loss_cap),
    noshowPct: Number(attendance.noshow_pct ?? 0.05),
    declinePct: Number(attendance.decline_pct ?? 0.015),
    penaltyMin: Number(attendance.penalty_min ?? 150000),
    penaltyMax: Number(attendance.penalty_max ?? 1000000),
    attendanceCap: Number(attendance.streak_bonus_cap ?? 250000),
    perPoint: per(1.4),
    perQuali: per(0.6),
    perSprint: per(1),
    headToHead: per(22.5),
    cleanWeekend: per(0.8),
    penaltyPoint: per(0.4),
  });

  return { content, ephemeral: false };
});
