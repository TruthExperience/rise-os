// components/router.ts
import { InteractionResponseType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveLeagueFromGuild } from "../league-resolver";
import { getOrCreateDriver } from "../commands/checkin";
import {
  buildCheckinEmbed,
  buildCheckinComponents,
  CHECKIN_STATUSES,
  type CheckinStatus,
} from "../commands/checkin-embed";
import { handleAppealPromptComponent } from "../commands/appeal";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Single entry point for every MESSAGE_COMPONENT interaction (button
 * clicks, select menus, etc). Dispatches by custom_id prefix:
 *   - "checkin_btn:<postId>:<status>" -> handleCheckinButton
 *   - "appeal_prompt:<yes|no>:<incidentId>" -> handleAppealPrompt
 * Anything else falls through to a generic "not wired up" reply so
 * unknown components fail loudly instead of silently.
 */
export async function routeComponent(interaction: any) {
  const customId: string = interaction.data?.custom_id ?? "";

  if (customId.startsWith("checkin_btn:")) {
    return handleCheckinButton(interaction, customId);
  }

  if (customId.startsWith("appeal_prompt:")) {
    return handleAppealPrompt(interaction, customId);
  }

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "This button isn't wired up yet.", flags: 64 },
  };
}

/**
 * Handles the Yes/No appeal buttons sent by tickets.ts's
 * sendAppealPromptDM. Deferred (type 6) rather than answered inline —
 * handleAppealPromptComponent does Supabase lookups plus, on "yes", a
 * full createAppealTicket() Discord channel-creation round trip, which
 * is the same class of slow work steward_analyse defers on the
 * commands side. Same waitUntil + PATCH-@original pattern as
 * patchOriginalResponse in commands/router.ts — components and
 * commands share the same webhooks/{app_id}/{token}/messages/@original
 * follow-up endpoint, so no new helper shape was needed, just reuse
 * of the pattern.
 */
async function handleAppealPrompt(interaction: any, customId: string) {
  const discordUserId: string =
    interaction.member?.user?.id ?? interaction.user?.id;
  const applicationId: string = interaction.application_id;
  const interactionToken: string = interaction.token;

  if (!discordUserId) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: "Couldn't identify you for that action.", components: [] },
    };
  }

  const backgroundWork = (async () => {
    let final: { content: string };
    try {
      final = await handleAppealPromptComponent(customId, discordUserId);
    } catch (err) {
      console.error("[discord] appeal_prompt background failed:", err);
      final = {
        content:
          "Something went wrong filing that appeal. Try `/appeal file` directly, or ping a steward.",
      };
    }
    await patchOriginalComponentMessage(applicationId, interactionToken, final.content);
  })();

  waitUntil(backgroundWork);

  // DEFERRED_UPDATE_MESSAGE (type 6): Discord shows the original DM
  // as-is (buttons momentarily still visible) until the PATCH below
  // lands. patchOriginalComponentMessage explicitly clears components
  // in that PATCH so the buttons still disappear once the real
  // content arrives — same end state as the synchronous UPDATE_MESSAGE
  // path, just not atomic with the ACK.
  return {
    type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
  };
}

async function patchOriginalComponentMessage(
  applicationId: string,
  interactionToken: string,
  content: string
) {
  try {
    const res = await fetch(
      `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, components: [] }),
      }
    );
    if (!res.ok) {
      console.error(
        "[discord] appeal_prompt followup PATCH failed:",
        res.status,
        await res.text()
      );
    }
  } catch (err) {
    console.error("[discord] appeal_prompt followup PATCH threw:", err);
  }
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
    .select(
      "id, round_id, division_id, weather_text, ping_delivery, race_time, track_override, country_override, flag_override"
    )
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
  const driverId = driverResult.driver.id;

  const { data: existing, error: existingError } = await supabase
    .schema("pitboss")
    .from("round_checkins")
    .select("status")
    .eq("round_id", post.round_id)
    .eq("driver_id", driverId)
    .maybeSingle();

  if (existingError) {
    console.error("[checkin_btn] existing-response lookup failed:", existingError);
    return ephemeralError(`Something went wrong checking your current response: ${existingError.message}`);
  }

  if (existing && existing.status === status) {
    const { error: deleteError } = await supabase
      .schema("pitboss")
      .from("round_checkins")
      .delete()
      .eq("round_id", post.round_id)
      .eq("driver_id", driverId);

    if (deleteError) {
      console.error("[checkin_btn] deselect delete failed:", deleteError);
      return ephemeralError(`Something went wrong clearing your response: ${deleteError.message}`);
    }
  } else {
    const { error: upsertError } = await supabase
      .schema("pitboss")
      .from("round_checkins")
      .upsert(
        {
          round_id: post.round_id,
          driver_id: driverId,
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
