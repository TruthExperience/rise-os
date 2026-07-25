export interface ResolvedDiscordUser {
  id: string;
  username: string;
}

export interface CommandContext {
  guildId: string;
  channelId: string;
  leagueId: string;
  leagueSlug: string;
  discordUserId: string;
  options: Record<string, unknown>;
  resolvedUsers: Record<string, ResolvedDiscordUser>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResponse>;

export interface CommandResponse {
  content: string;
  ephemeral?: boolean;
}

export const commandRegistry = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler) {
  commandRegistry.set(name, handler);
}
