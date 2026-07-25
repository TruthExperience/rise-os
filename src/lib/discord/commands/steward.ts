import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

// Same driver-lookup/auto-create pattern as roster.ts's getTeamId
// section — a reporter (or accused party) may not have a `drivers`
// row yet if they've never touched roster/cert commands before.
async function getOrCreateDriverId(
  discordId: string,
  username?: string
): Promise<string | null> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .schema("pitboss")
    .from("drivers")
    .insert({
      discord_id: discordId,
      discord_username: username ?? discordId,
    })
    .select("id")
    .single();

  if (error || !created) {
    console.error("[steward] driver creation failed:", error);
    return null;
  }
  return created.id;
}

registerCommand("steward_report", async (ctx) => {
  const incidentType = ctx.options.type as string;
  const description = ctx.options.description as string;
  const accusedDiscordId = ctx.options.accused as string | undefined;
  const lap = ctx.options.lap as number | undefined;
  const round = ctx.options.round as number | undefined;
  const evidenceUrl = ctx.options.evidence as string | undefined;

  const reporterId = await getOrCreateDriverId(ctx.discordUserId);
  if (!reporterId) {
    return {
      content: "Couldn't set up your driver record — try again in a moment.",
      ephemeral: true,
    };
  }

  let accusedDriverId: string | null = null;
  let accusedUsername: string | null = null;
  if (accusedDiscordId) {
    accusedUsername = ctx.resolvedUsers[accusedDiscordId]?.username ?? null;
    accusedDriverId = await getOrCreateDriverId(
      accusedDiscordId,
      accusedUsername ?? undefined
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .insert({
      league_id: ctx.leagueId,
      reported_by: reporterId,
      accused_driver_id: accusedDriverId,
      accused_discord_username: accusedUsername,
      incident_type: incidentType,
      description,
      lap: lap ?? null,
      round: round ?? null,
      evidence_urls: evidenceUrl ? [evidenceUrl] : [],
      status: "open",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[steward_report] insert failed:", error);
    return {
      content: `Something went wrong filing that report: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  const shortId = data.id.slice(0, 8);
  return {
    content: `Incident **${shortId}** filed (${incidentType}). Stewards will review it — check status with \`/steward status\`.`,
    ephemeral: true,
  };
});

registerCommand("steward_status", async (ctx) => {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select("id, incident_type, status, created_at, accused_discord_username")
    .eq("league_id", ctx.leagueId)
    .in("status", ["open", "under_review", "appealed"])
    .order("created_at", { ascending: false })
    .limit(5);

  if (error || !data) {
    console.error("[steward_status] query failed:", error);
    return {
      content: `Couldn't load incident status: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  if (data.length === 0) {
    return { content: "No open incidents for this league.", ephemeral: true };
  }

  const lines = data.map((inc) => {
    const shortId = inc.id.slice(0, 8);
    const against = inc.accused_discord_username
      ? ` vs ${inc.accused_discord_username}`
      : "";
    return `**${shortId}** — ${inc.incident_type}${against} — *${inc.status}*`;
  });

  return { content: lines.join("\n"), ephemeral: true };
});
