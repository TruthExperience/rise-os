// registry.ts
//
// Central registry for Discord slash command handlers. Individual command
// files (steward.ts, appeal.ts, driver.ts, roster.ts, etc.) call
// registerCommand() at module load time to add themselves here; router.ts
// reads commandRegistry to dispatch an incoming interaction to the right
// handler.

export type CommandContext = {
  discordUserId: string;
  leagueId: string;
  guildId: string;
  channelId: string;
  options: Record<string, string | number | boolean | undefined>;
  resolvedUsers: Record<string, { username: string }>;
};

export type CommandResponse = {
  content: string;
  ephemeral?: boolean;
};

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResponse>;

// Keyed by the full command name as sent by Discord — e.g. "sign-driver",
// or "steward status" for a base command + subcommand pair. router.ts is
// responsible for building that key the same way when it looks a handler
// up.
export const commandRegistry = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  if (commandRegistry.has(name)) {
    console.warn(`[registry] command "${name}" is being re-registered — overwriting previous handler.`);
  }
  commandRegistry.set(name, handler);
}
