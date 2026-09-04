import { InteractionResponseType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { resolveLeagueFromGuild } from "../league-resolver";
import {
  commandRegistry,
  registerCommand,
  type ResolvedDiscordUser,
  type ResolvedDiscordAttachment,
} from "./registry";

registerCommand("ping", async () => ({
  content: "Pong. AARL/TRL/WSC/SRH bot is alive.",
  ephemeral: true,
}));

export { registerCommand };

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Handles an APPLICATION_COMMAND interaction. Supports both flat
 * commands (/ping) and one level of subcommand (/roster view) by
 * building a dispatch key of "<command>" or "<command>_<subcommand>".
 */
export async function routeCommand(interaction: any) {
  const topLevelName: string = interaction.data?.name;
  const guildId: string = interaction.guild_id;
  const channelId: string = interaction.channel_id;
  const discordUserId: string =
    interaction.member?.user?.id ?? interaction.user?.id;
  const applicationId: string = interaction.application_id;
  const interactionToken: string = interaction.token;

  // Discord includes these directly on the interaction payload for any
  // command invoked in a guild (which is all commands here, since league
  // resolution requires guild_id). roles is an array of role ID strings;
  // permissions is a stringified bitfield already computed by Discord
  // (base role perms + channel overwrites), so no separate fetch needed.
  const memberRoles: string[] = interaction.member?.roles ?? [];
  const memberPermissions: string = interaction.member?.permissions ?? "0";

  let commandKey = topLevelName;
  let rawOptions: any[] = interaction.data?.options ?? [];
  if (rawOptions.length === 1 && rawOptions[0].type === 1) {
    commandKey = `${topLevelName}_${rawOptions[0].name}`;
    rawOptions = rawOptions[0].options ?? [];
  }

  const handler = commandRegistry.get(commandKey);
  if (!handler) {
    return respond(`Unknown command: /${topLevelName}`, true);
  }

  const league = await resolveLeagueFromGuild(guildId);
  if (!league) {
    return respond(
      "This Discord server isn't linked to a PitBoss league yet. Ask an admin to set `discord_server_id` on the league record.",
      true
    );
  }

  const options: Record<string, unknown> = {};
  for (const opt of rawOptions) {
    options[opt.name] = opt.value;
  }

  const resolvedUsers: Record<string, ResolvedDiscordUser> = {};
  const rawResolvedUsers = interaction.data?.resolved?.users ?? {};
  for (const [id, user] of Object.entries(rawResolvedUsers) as [string, any][]) {
    resolvedUsers[id] = { id, username: user.username };
  }

  // Attachment options (type 11, e.g. steward report's evidence_file) come
  // back from Discord as just the attachment's snowflake ID in `options` —
  // the actual CDN url/filename/content type live in
  // interaction.data.resolved.attachments, keyed by that same ID. Resolved
  // the same way resolvedUsers is above, so handlers can do
  // ctx.resolvedAttachments[ctx.options.evidence_file as string].
  const resolvedAttachments: Record<string, ResolvedDiscordAttachment> = {};
  const rawResolvedAttachments = interaction.data?.resolved?.attachments ?? {};
  for (const [id, att] of Object.entries(rawResolvedAttachments) as [string, any][]) {
    resolvedAttachments[id] = {
      id,
      url: att.url,
      filename: att.filename,
      contentType: att.content_type,
    };
  }

  try {
    const result = await handler({
      guildId,
      channelId,
      leagueId: league.id,
      leagueSlug: league.slug,
      discordUserId,
      options,
      resolvedUsers,
      resolvedAttachments,
      memberRoles,
      memberPermissions,
    });

    // A handler can opt into deferral instead of answering inline (see
    // steward_analyse). We ACK Discord immediately with type 5, then run
    // the slow work via waitUntil() and PATCH the real result into the
    // original response once it resolves. waitUntil (from
    // @vercel/functions, not next/server's after()) is used because
    // after() only exists from Next.js 15.1+ — this project is on 14.2.3.
    if ("defer" in result && result.defer) {
      const backgroundFn = result.background;

      const backgroundWork = (async () => {
        let final: { content: string };
        try {
          final = await backgroundFn();
        } catch (err) {
          console.error(`[discord] /${commandKey} background failed:`, err);
          final = {
            content:
              "Something went wrong finishing that up. Try running the command again.",
          };
        }
        await patchOriginalResponse(applicationId, interactionToken, final.content);
      })();

      waitUntil(backgroundWork);

      return {
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: result.ephemeral ? 64 : undefined,
        },
      };
    }

    return respond(result.content, result.ephemeral, result.embeds, result.components);
  } catch (err) {
    console.error(`[discord] /${commandKey} failed:`, err);
    return respond(
      "Something went wrong running that command. Try again, or ping the commissioner if it keeps failing.",
      true
    );
  }
}

async function patchOriginalResponse(
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
        body: JSON.stringify({ content }),
      }
    );
    if (!res.ok) {
      console.error("[discord] followup PATCH failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[discord] followup PATCH threw:", err);
  }
}

function respond(
  content: string,
  ephemeral = false,
  embeds?: Record<string, unknown>[],
  components?: Record<string, unknown>[]
) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? 64 : undefined,
      embeds: embeds && embeds.length > 0 ? embeds : undefined,
      components: components && components.length > 0 ? components : undefined,
    },
  };
}

// Side-effect import: registers the roster_* commands.
import "./roster";
// Side-effect import: registers the kb_* commands.
import "./kb";
// Side-effect import: registers the steward_* commands.
import "./steward";
// Side-effect import: registers the appeal_* commands.
import "./appeal";
// Side-effect import: registers the kick/ban/lockdown/endlockdown commands.
import "./moderation";
// Side-effect import: registers the sign-driver/release-driver commands.
import "./driver";
// Side-effect import: registers the contract_* commands.
import "./contract";
// Side-effect import: registers the checkin/checkin-status/checkin-remind/
// checkin-create/generate-grid commands.
import "./checkin";
// Side-effect import: registers the cap_* commands.
import "./cap";
// Side-effect import: registers the ddv_* and tp_view commands.
import "./ddv";
