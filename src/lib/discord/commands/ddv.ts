// ddv.ts
import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

type DriverMatch = {
  id: string;
  displayName: string;
  discordId: string | null;
};

async function resolveDriver(
  supabase: ReturnType<typeof createAdminClient>,
  leagueId: string,
  query: string
): Promise<{ driver?: DriverMatch; error?: string }> {
  const { data: memberships, error: membershipError } = await supabase
    .schema("pitboss")
    .from("driver_leagues")
    .select("driver_id")
    .eq("league_id", leagueId);

  if (membershipError) {
    console.error("[ddv] driver_leagues lookup failed:", membershipError);
    return { error: `Couldn't look up drivers in this league: ${membershipError.message}` };
  }
  if (!memberships || memberships.length === 0) {
    return { error: "No drivers found in this league." };
  }

  const { data, error } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id, display_name, discord_username, discord_id")
    .in(
      "id",
      memberships.map((m) => m.driver_id)
    )
    .or(`display_name.ilike.%${query}%,discord_username.ilike.%${query}%`);

  if (error) {
    console.error("[ddv] driver lookup failed:", error);
    return { error: `Couldn't look up that driver: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { error: `No driver matching "${query}" in this league.` };
  }
  if (data.length > 1) {
    const names = data.map((d) => d.display_name ?? d.discord_username).join(", ");
    return {
      error: `That matches more than one driver: ${names}. Be more specific.`,
    };
  }

  return {
    driver: {
      id: data[0].id,
      displayName: data[0].display_name ?? data[0].discord_username ?? "Unknown Driver",
      discordId: data[0].discord_id,
    },
  };
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

function fmtDDV(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString("en-US")} $TRL`;
}

registerCommand("ddv_view", async (ctx) => {
  const supabase = createAdminClient();
  const query = ctx.options.driver as string | undefined;

  if (!query) {
    return { content: "Specify a driver.", ephemeral: true };
  }

  const resolved = await resolveDriver(supabase, ctx.leagueId, query);
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

  const query = ctx.options.driver as string | undefined;
  const amount = ctx.options.ddv as number | undefined;
  const reason = ctx.options.reason as string | undefined;

  if (!query) {
    return { content: "Specify a driver.", ephemeral: true };
  }
  if (amount === undefined || amount < 0) {
    return { content: "Specify a valid DDV amount.", ephemeral: true };
  }
  if (!reason || reason.trim().length === 0) {
    return { content: "A reason is required for manual DDV adjustments.", ephemeral: true };
  }

  const supabase = createAdminClient();
  const resolved = await resolveDriver(supabase, ctx.leagueId, query);
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
