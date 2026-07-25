import { InteractionResponseType } from "discord-interactions";
import { resolveLeagueFromGuild } from "../league-resolver";
import {
  commandRegistry,
  registerCommand,
  type ResolvedDiscordUser,
} from "./registry";

registerCommand("ping", async () => ({
  content: "Pong. AARL/TRL/WSC/SRH bot is alive.",
  ephemeral: true,
}));

export { registerCommand };

/**
 * Handles an APPLICATION_COMMAND interaction. Supports both flat
 * commands (/ping) and one level of subcommand (/roster view) by
 * building a dispatch key of "<command>" or "<command>_<subcommand>".
 */
export async function routeCommand(interaction: any) {
  const topLevelName: string = interaction.data?.name;
  const guildId: string = interaction.guild_id;
  const discordUserId: string =
    interaction.member?.user?.id ?? interaction.user?.id;

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

  try {
    const result = await handler({
      guildId,
      leagueId: league.id,
      leagueSlug: league.slug,
      discordUserId,
      options,
      resolvedUsers,
    });
    return respond(result.content, result.ephemeral);
  } catch (err) {
    console.error(`[discord] /${commandKey} failed:`, err);
    return respond(
      "Something went wrong running that command. Try again, or ping the commissioner if it keeps failing.",
      true
    );
  }
}

function respond(content: string, ephemeral = false) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? 64 : undefined,
    },
  };
}

// Side-effect import: registers the roster_* commands.
import "./roster";

// Side-effect import: registers the kb_* commands.
import "./kb";
