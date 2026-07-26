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

// A handler either answers inline within Discord's 3s ACK window, or
// defers: the router ACKs immediately and runs `background` afterward via
// after(), PATCHing the resolved content into the original response once
// it's done. See steward_analyse for the deferred case.
export type CommandResponse = ImmediateResponse | DeferredResponse;

export interface ImmediateResponse {
  defer?: false;
  content: string;
  ephemeral?: boolean;
}

export interface DeferredResponse {
  defer: true;
  ephemeral?: boolean;
  background: () => Promise<{ content: string }>;
}

export const commandRegistry = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler) {
  commandRegistry.set(name, handler);
}
