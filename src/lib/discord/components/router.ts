import { InteractionResponseType } from "discord-interactions";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveLeagueFromGuild } from "../league-resolver";
import { getOrCreateDriver } from "../commands/checkin";
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  CHECKIN_STATUSES,
  type CheckinStatus,
} from "../commands/checkin-embed";

/**
 * Single entry point for every MESSAGE_COMPONENT interaction (button
 * clicks, select menus, etc). Currently only handles the check-in
 * buttons (custom_id "checkin_btn:<postId>:<status>") — anything else
 * falls through to a generic "not wired up" reply so unknown
 * components fail loudly instead of silently.
 */
export async function routeComponent(interaction: any) {
  const customId: string = interaction.data?.custom_id ?? "";

  if (customId.startsWith("checkin_btn:")) {
    return handleCheckinButton(interaction, customId);
  }

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "This button isn't wired up yet.", flags: 64 },
  };
}

async function handleCheckinButton(interaction: any, customId: string) {
  const [, postId, status] = customId.split(":");
  if (!postId || !CHECKIN_STATUSES.includes(status as CheckinStatus)) {
    return ephemeralError("Malformed check-in button — ping the commissioner.");
  }

  const guildId: string = interaction.guild_id;
  const discordUserId: string = interaction.member?.user?.id ?? interaction.user?.id;
  const username: string | undefined = interaction.member?.user?.username;

  const league = await resolveLeagueFromGuild(guildId);
  if (!league) {
    return ephemeralError("This server isn't linked to a PitBoss league.");
  }

  const supabase = createAdminClient();

  const { data: post, error: postError } = await supabase
    .schema("pitboss")
    .from("round_checkin_posts")
    .select("id, round_id, division_id, weather_text, ping_delivery, race_time")
    .eq("id", postId)
    .maybeSingle();

  if (postError || !post) {
    console.error("[checkin_btn] post lookup failed:", postError);
    return ephemeralError("Couldn't find this check-in — it may have been removed.");
  }

  const { data: division, error: divisionError } = await supabase
    .schema("rise_os")
    .from("league_divisions")
    .select("division_code")
    .eq("id", post.division_id)
    .maybeSingle();

  if (divisionError || !division) {
    console.error("[checkin_btn] division lookup failed:", divisionError);
    return ephemeralError("Couldn't resolve the division for this check-in.");
  }

  const { data: round, error: roundError } = await supabase
    .schema("rise_os")
    .from("calendar_rounds")
    .select("name, round_number, circuit, country, flag_emoji")
    .eq("id", post.round_id)
    .maybeSingle();

  if (roundError || !round) {
    console.error("[checkin_btn] round lookup failed:", roundError);
    return ephemeralError("Couldn't resolve the round for this check-in.");
  }

  const driverResult = await getOrCreateDriver(discordUserId, username);
  if ("error" in driverResult) {
    return ephemeralError(`Couldn't resolve your driver record: ${driverResult.error}`);
  }

  const { error: upsertError } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .upsert(
      {
        round_id: post.round_id,
        driver_id: driverResult.driver.id,
        league_id: league.id,
        division_id: post.division_id,
        status,
        checked_in_at: new Date().toISOString(),
        responded_via: "button",
      },
      { onConflict: "round_id,driver_id" }
    );

  if (upsertError) {
    console.error("[checkin_btn] upsert failed:", upsertError);
    return ephemeralError(`Something went wrong saving your response: ${upsertError.message}`);
  }

  const { data: checkins, error: checkinsError } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("status, drivers(discord_id)")
    .eq("round_id", post.round_id)
    .eq("division_id", post.division_id);

  if (checkinsError) {
    console.error("[checkin_btn] refetch failed:", checkinsError);
    return ephemeralError("Saved your response, but couldn't refresh the check-in list.");
  }

  const grouped: Partial<Record<CheckinStatus, string[]>> = {};
  for (const row of checkins ?? []) {
    const discordId = (row as any).drivers?.discord_id;
    const s = row.status as CheckinStatus;
    if (!discordId || !CHECKIN_STATUSES.includes(s)) continue;
    grouped[s] = grouped[s] ?? [];
    grouped[s]!.push(discordId);
  }

  const embed = buildCheckinEmbed({
    round,
    divisionCode: division.division_code,
    post,
    grouped,
  });
  const components = buildCheckinComponents(post.id);

  // UPDATE_MESSAGE (type 7) edits the original message in place as the
  // interaction response itself — no separate PATCH call needed, and
  // it's the fastest path within Discord's 3s ACK window.
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { embeds: [embed], components },
  };
}

function ephemeralError(content: string) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: 64 },
  };
}
