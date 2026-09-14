export interface ResolvedDiscordUser {
  id: string;
  username: string;
}

/**
 * Metadata for a file attached to a slash command option of type
 * ATTACHMENT (11) — e.g. steward report's evidence_file. Discord
 * sends only the attachment's snowflake ID as the option value;
 * the actual CDN url/filename/content type live in
 * interaction.data.resolved.attachments, keyed by that ID. The
 * router resolves these into this shape the same way it already
 * does for resolvedUsers.
 */
export interface ResolvedDiscordAttachment {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
}

/**
 * A file to attach to the deferred followup PATCH (Discord's
 * PATCH-original-response endpoint accepts multipart/form-data with
 * file parts, same as the initial webhook). Used by handlers whose
 * background work produces something to hand back — e.g. an exported
 * report or rendered image.
 */
export interface DeferredResponseFile {
  filename: string;
  contentType?: string;
  data: Buffer | Uint8Array | ArrayBuffer;
}

export interface CommandContext {
  guildId: string | undefined;
  channelId: string | undefined;
  leagueId: string | undefined;
  leagueSlug: string | undefined;
  discordUserId: string;
  options: Record<string, unknown>;
  resolvedUsers: Record<string, ResolvedDiscordUser>;
  /**
   * Attachments resolved from any ATTACHMENT-type options on this
   * command (e.g. evidence_file). Keyed by attachment ID, which is
   * the raw value Discord puts in `options` for that option — look
   * up ctx.resolvedAttachments[ctx.options.evidence_file as string]
   * to get the actual url/filename.
   */
  resolvedAttachments: Record<string, ResolvedDiscordAttachment>;
  /** Role IDs the invoking member holds in this guild. */
  memberRoles: string[];
  /**
   * The invoking member's computed permissions in this channel, as a
   * string bitfield straight from Discord's interaction payload.
   * Discord guarantees this always includes ADMINISTRATOR for the
   * guild owner, regardless of their roles.
   */
  memberPermissions: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResponse>;

// A handler either answers inline within Discord's 3s ACK window, or
// defers: the router ACKs immediately and runs `background` afterward via
// after(), PATCHing the resolved content (and optionally files) into the
// original response once it's done. See steward_analyse for the deferred
// case.
export type CommandResponse = ImmediateResponse | DeferredResponse;

export interface ImmediateResponse {
  defer?: false;
  content?: string;
  ephemeral?: boolean;
  embeds?: Record<string, unknown>[];
  components?: Record<string, unknown>[];
}

export interface DeferredResponse {
  defer: true;
  ephemeral?: boolean;
  background: () => Promise<{ content: string; files?: DeferredResponseFile[] }>;
}

export const commandRegistry = new Map<string, CommandHandler>();

// Commands in this set are allowed to run without a resolved league
// (e.g. steward_respond, which is written to work from a DM with no
// guild_id and therefore no league to resolve). Every other command
// keeps the hard "not linked" requirement in the router.
const leagueOptionalCommands = new Set<string>();

export function registerCommand(
  name: string,
  handler: CommandHandler,
  options?: { leagueOptional?: boolean }
) {
  commandRegistry.set(name, handler);
  if (options?.leagueOptional) {
    leagueOptionalCommands.add(name);
  }
}

export function isLeagueOptional(name: string): boolean {
  return leagueOptionalCommands.has(name);
}
