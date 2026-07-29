// pitboss-guardian/src/index.ts
//
// Cloudflare Worker + Durable Object that maintains a persistent
// connection to the Discord Gateway for AARL, watching for raid
// (mass suspicious joins) and nuke (mass destructive actions)
// patterns, and responding automatically.
//
// PILOT SCOPE: AARL only. Hardcoded below rather than pulled from
// Supabase — deliberately, so this can't silently start acting on a
// guild nobody reviewed the config for. Expand to a real per-guild
// config table once the pilot's thresholds are validated.

interface Env {
  GUARDIAN: DurableObjectNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Single fixed DO instance — this Worker manages exactly one
    // guild's Gateway connection for the pilot.
    const id = env.GUARDIAN.idFromName("aarl-guardian");
    const stub = env.GUARDIAN.get(id);

    // Simple admin surface: hitting /start (with the right header)
    // boots the Gateway connection if it isn't already running.
    // Durable Objects don't self-start on deploy — something has to
    // make the first request to wake one up.
    if (url.pathname === "/start") {
      const provided = req.headers.get("X-Guardian-Key")?.trim();
      if (provided !== env.DISCORD_BOT_TOKEN?.trim()) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stub.fetch(req);
    }

    if (url.pathname === "/status") {
      return stub.fetch(req);
    }

    return new Response("pitboss-guardian", { status: 200 });
  },

  // Cron Trigger (see wrangler.toml `[triggers]`) — fires every 5
  // minutes and pings /start on the DO directly. This is the
  // self-healing measure from the original design notes: harmless
  // no-op if already connected, but recovers automatically if the
  // Gateway connection ever silently dies without a clean close.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.GUARDIAN.idFromName("aarl-guardian");
    const stub = env.GUARDIAN.get(id);
    ctx.waitUntil(
      stub.fetch("https://internal/start", {
        headers: { "X-Guardian-Key": env.DISCORD_BOT_TOKEN },
      }).catch((err) => {
        console.error("[guardian] scheduled /start ping failed:", err);
      })
    );
  },
};

// ─── Config (AARL pilot — hardcoded) ──────────────────────────────────────────

const GUILD_ID = "1510688925784608809";
const TICKET_CATEGORY_ID = "1530534575829422110";
const STEWARD_ROLE_ID = "1516542505443659946";
const ALERTS_CHANNEL_ID = "1531851227611140196"; // #security-alerts

// ─── Scoring thresholds ────────────────────────────────────────────────────────

const RAID_WINDOW_MS = 60_000;
const RAID_SCORE_THRESHOLD = 10;

const NUKE_WINDOW_MS = 30_000;
const NUKE_DELETE_THRESHOLD = 3; // channel/role deletions by one actor
const NUKE_BAN_KICK_THRESHOLD = 5; // bans/kicks by one actor

// Discord audit log action types relevant here.
// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
const AUDIT_ACTION = {
  CHANNEL_DELETE: 12,
  ROLE_DELETE: 32,
  MEMBER_BAN_ADD: 22,
  MEMBER_KICK: 20,
  WEBHOOK_CREATE: 50,
  ROLE_UPDATE: 31,
} as const;

const DANGEROUS_PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_WEBHOOKS: 1n << 29n,
} as const;

// ─── Durable Object ────────────────────────────────────────────────────────────

interface RaidScoreEntry {
  timestamp: number;
  score: number;
  discordUserId: string;
  reasons: string[];
}

interface NukeActionEntry {
  timestamp: number;
  actionType: number;
}

export class GuildGuardian implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private ws: WebSocket | null = null;
  private heartbeatInterval: number | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private heartbeatAckReceived = true;
