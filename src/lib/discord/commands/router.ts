import { InteractionResponseType } from "discord-interactions";
import { resolveLeagueFromGuild } from "../league-resolver";

export interface CommandContext {
  guildId: string;
  leagueId: string;
  leagueSlug: string;
  discordUserId: string;
  options: Record<string, unknown>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResponse>;

export interface CommandResponse {
  content: string;
  ephemeral?: boolean;
}

// Phase 1: just /ping, to prove the round trip end-to-end.
// Later phases register /roster, /register, /standings, /incident, /cert here.
const commandRegistry = new Map<string, CommandHandler>();

commandRegistry.set("ping", async () => ({
  content: "Pong. AARL/TRL/WSC/SRH bot is alive.",
  ephemeral: true,
}));

export function registerCommand(name: string, handler: CommandHandler) {
  commandRegistry.set(name, handler);
}

/**
 * Handles an APPLICATION_COMMAND interaction: resolves the league
 * from the guild, extracts options, dispatches to the matching
 * handler, and shapes the result into a Discord interaction
 * response body.
 */
export async function routeCommand(interaction: any) {
  const commandName: string = interaction.data?.name;
  const guildId: string = interaction.guild_id;
  const discordUserId: string =
    interaction.member?.user?.id ?? interaction.user?.id;

  const handler = commandRegistry.get(commandName);
  if (!handler) {
    return respond(`Unknown command: /${commandName}`, true);
  }

  const league = await resolveLeagueFromGuild(guildId);
  if (!league) {
    return respond(
      "This Discord server isn't linked to a PitBoss league yet. Ask an admin to set `discord_server_id` on the league record.",
      true
    );
  }

  const options: Record<string, unknown> = {};
  for (const opt of interaction.data?.options ?? []) {
    options[opt.name] = opt.value;
  }

  try {
    const result = await handler({
      guildId,
      leagueId: league.id,
      leagueSlug: league.slug,
      discordUserId,
      options,
    });
    return respond(result.content, result.ephemeral);
  } catch (err) {
    console.error(`[discord] /${commandName} failed:`, err);
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
      flags: ephemeral ? 64 : undefined, // 64 = EPHEMERAL
    },
  };
}
