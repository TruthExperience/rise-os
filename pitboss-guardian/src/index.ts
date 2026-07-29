// pitboss-guardian/src/index.ts
//// pitboss-guardian/src/index.ts
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

    // /status exposes a masked token preview and live connection
    // state -- gated the same as /start rather than left open.
    if (url.pathname === "/status") {
      const provided = req.headers.get("X-Guardian-Key")?.trim();
      if (provided !== env.DISCORD_BOT_TOKEN?.trim()) {
        return new Response("Unauthorized", { status: 401 });
      }
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

// Actions by these Discord user IDs are never scored as raid/nuke
// triggers — meant for commissioners/head stewards who legitimately
// do bulk moderation (mass bans, role cleanups) that would otherwise
// look identical to a nuke. Does NOT exempt them from the bot
// self-removal protection below — that check runs first and applies
// regardless of whitelist status.
const WHITELISTED_ACTOR_IDS: string[] = [
  "1047084061027471480", // truthexperience (owner)
  "1401841577478848603", // _colapintolover (co-owner)
  "1248351138302922883", // yello_y (co-owner)
];

// Direct-message fallback recipients if posting to ALERTS_CHANNEL_ID
// fails — most likely because the channel itself was a casualty of
// the nuke.
const BACKUP_ALERT_DISCORD_IDS: string[] = [
  "1047084061027471480", // truthexperience (owner)
  "1401841577478848603", // _colapintolover (co-owner)
  "1248351138302922883", // yello_y (co-owner)
];

// Only this account may remove PitBoss from the guild. Co-owners are
// whitelisted for everything else above, but NOT for this — see the
// self-protection check at the top of scoreAuditEntry, which runs
// before the whitelist bypass. Note this is detection/alert only, not
// prevention: Discord processes a kick/ban before any Gateway event
// reaches us, so if it succeeds we lose guild access entirely (only
// the DM-to-backup-contacts and Supabase logging still work
// afterward, since neither needs guild access). The actual preventive
// control is Discord's own role hierarchy — keep PitBoss's role
// positioned ABOVE both co-owner roles in Server Settings > Roles;
// only the true guild owner can kick/ban a member whose top role
// outranks their own, regardless of KICK_MEMBERS/BAN_MEMBERS perms.
const OWNER_DISCORD_ID = "1047084061027471480"; // truthexperience

// ─── Scoring thresholds ────────────────────────────────────────────────────────

const RAID_WINDOW_MS = 60_000;
const RAID_SCORE_THRESHOLD = 10;
const RAID_JOIN_COUNT_THRESHOLD = 8; // raw joins in-window, independent of score
const AVATAR_HASH_SHARE_THRESHOLD = 3; // distinct users sharing one avatar hash

const NUKE_WINDOW_MS = 30_000;
const NUKE_DELETE_THRESHOLD = 3; // channel/role deletions by one actor
const NUKE_BAN_KICK_THRESHOLD = 5; // bans/kicks by one actor
const NUKE_CREATE_THRESHOLD = 5; // channel/role creations by one actor (spam)
const NUKE_ROLE_GRANT_THRESHOLD = 5; // role additions to members by one actor
const NUKE_WEBHOOK_THRESHOLD = 1; // webhook creations by one actor -- zero-tolerance, made explicit
const NUKE_BOT_ADD_THRESHOLD = 1; // bot/integration adds by one actor -- zero-tolerance, made explicit

// Discord audit log action types relevant here.
// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
const AUDIT_ACTION = {
  GUILD_UPDATE: 1,
  CHANNEL_CREATE: 10,
  CHANNEL_DELETE: 12,
  MEMBER_KICK: 20,
  MEMBER_BAN_ADD: 22,
  MEMBER_ROLE_UPDATE: 25,
  BOT_ADD: 28,
  ROLE_CREATE: 30,
  ROLE_UPDATE: 31,
  ROLE_DELETE: 32,
  WEBHOOK_CREATE: 50,
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
  avatarHash: string | null;
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

  // Tracks consecutive auth-failure closes (invalid token, etc.) so
  // reconnect backoff can grow instead of hammering Discord's Gateway
  // at a flat interval when the token itself is the problem.
  private consecutiveAuthFailures = 0;

  // In-memory scoring windows. Short-lived (30-60s) by design, so
  // losing these on a DO restart/eviction is an acceptable tradeoff
  // versus the complexity of persisting a rolling window to storage.
  private raidScores: RaidScoreEntry[] = [];
  private nukeActionsByActor: Map<string, NukeActionEntry[]> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/start") {
      if (!this.ws || this.ws.readyState !== WebSocket.READY_STATE_OPEN) {
        await this.connectGateway();
        return new Response("Gateway connection starting.", { status: 200 });
      }
      return new Response("Already connected.", { status: 200 });
    }

    if (url.pathname === "/status") {
      const token = this.env.DISCORD_BOT_TOKEN ?? "";
      return Response.json({
        connected: this.ws?.readyState === WebSocket.READY_STATE_OPEN,
        sessionId: this.sessionId,
        sequence: this.sequence,
        raidScoreWindowSize: this.raidScores.length,
        nukeActorsTracked: this.nukeActionsByActor.size,
        consecutiveAuthFailures: this.consecutiveAuthFailures,
        // TEMPORARY diagnostic — kept intentionally for now. Never
        // logs the full token, only enough to confirm the secret's
        // shape matches what's expected (length, whether it
        // accidentally includes a "Bot " prefix, and a masked
        // first/last few characters for visual comparison against
        // the Discord Developer Portal).
        tokenDiagnostic: {
          length: token.length,
          startsWithBotPrefix: token.startsWith("Bot "),
          hasLeadingOrTrailingWhitespace: token !== token.trim(),
          preview: token.length > 10
            ? `${token.slice(0, 6)}...${token.slice(-4)}`
            : "(too short to preview)",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── Gateway connection ─────────────────────────────────────────────────────

  private async connectGateway(resumeUrl?: string) {
    // fetch() does not accept ws:// or wss:// as a URL scheme — it throws
    // a TypeError immediately if given one. The Upgrade: websocket header
    // is what actually signals the protocol switch; the URL itself must
    // use http(s). Discord's gateway URLs (both the initial endpoint and
    // resume_gateway_url from READY) come in wss:// form, so they need
    // converting here before being passed to fetch().
    const rawUrl = resumeUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    const gatewayUrl = rawUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

    const res = await fetch(gatewayUrl, {
      headers: { Upgrade: "websocket" },
    });

    const ws = res.webSocket;
    if (!ws) {
      console.error("[guardian] Gateway upgrade failed — no webSocket on response");
      // Retry after a delay rather than looping tightly.
      await this.scheduleReconnect(5000);
      return;
    }

    ws.accept();
    this.ws = ws;

    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("close", (event) => this.handleClose(event));
    ws.addEventListener("error", (event) => {
      console.error("[guardian] WebSocket error:", event);
    });
  }

  private async handleMessage(event: MessageEvent) {
    const payload = JSON.parse(event.data as string);
    const { op, d, s, t } = payload;

    if (s !== null && s !== undefined) this.sequence = s;

    switch (op) {
      case 10: // HELLO
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.resumeGatewayUrl) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case 11: // HEARTBEAT_ACK
        this.heartbeatAckReceived = true;
        break;

      case 1: // HEARTBEAT REQUEST — Discord can ask for an
        // out-of-cycle heartbeat; respond immediately rather than
        // waiting for the next scheduled interval tick.
        this.heartbeatAckReceived = false;
        this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
        break;

      case 0: // DISPATCH
        await this.handleDispatch(t, d);
        break;

      case 7: // RECONNECT
        this.ws?.close(4000, "reconnect requested");
        break;

      case 9: // INVALID_SESSION
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        // Discord asks for a short random delay before re-identifying.
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));
        this.sendIdentify();
        break;
    }
  }

  private sendIdentify() {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.env.DISCORD_BOT_TOKEN?.trim(),
          intents:
            (1 << 1) | // GUILD_MEMBERS (required for GUILD_MEMBER_ADD)
            (1 << 2), // GUILD_MODERATION (required for GUILD_AUDIT_LOG_ENTRY_CREATE)
          properties: {
            os: "cloudflare-workers",
            browser: "pitboss-guardian",
            device: "pitboss-guardian",
          },
        },
      })
    );
  }

  private sendResume() {
    this.ws?.send(
      JSON.stringify({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN?.trim(),
          session_id: this.sessionId,
          seq: this.sequence,
        },
      })
    );
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatAckReceived = true;

    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        // Missed the previous ACK — connection is dead, force a
        // reconnect rather than keep sending into the void.
        console.error("[guardian] Heartbeat ACK missed — reconnecting");
        this.ws?.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAckReceived = false;
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
    }, intervalMs) as unknown as number;
  }

  private async handleClose(event: CloseEvent) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    console.error("[guardian] Gateway closed:", event.code, event.reason);

    // Codes that mean "don't try to resume, start fresh."
    const noResumeCodes = [4004, 4010, 4011, 4012, 4013, 4014];
    if (noResumeCodes.includes(event.code)) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
    }

    // 4004 = authentication failed (bad token). Retrying at the normal
    // short jitter just hammers Discord's Gateway with failed
    // IDENTIFYs indefinitely if the token is actually broken -- back
    // off exponentially instead, capped at 5 minutes. Any other close
    // code resets the counter, since it's not an auth problem.
    if (event.code === 4004) {
      this.consecutiveAuthFailures++;
      const backoffMs = Math.min(5 * 60_000, 5000 * 2 ** this.consecutiveAuthFailures);
      console.error(
        `[guardian] Auth failure #${this.consecutiveAuthFailures} — backing off ${backoffMs}ms before retry`
      );
      await this.scheduleReconnect(backoffMs);
      return;
    }
    this.consecutiveAuthFailures = 0;

    await this.scheduleReconnect(2000 + Math.random() * 3000);
  }

  private async scheduleReconnect(delayMs: number) {
    await new Promise((r) => setTimeout(r, delayMs));
    await this.connectGateway(this.resumeGatewayUrl ?? undefined);
  }

  // ─── Dispatch handling ───────────────────────────────────────────────────────

  private async handleDispatch(type: string, data: any) {
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.consecutiveAuthFailures = 0;
        console.log("[guardian] READY — session established");
        break;

      case "RESUMED":
        console.log("[guardian] Session resumed");
        break;

      case "GUILD_MEMBER_ADD":
        if (data.guild_id === GUILD_ID) {
          await this.scoreJoin(data);
        }
        break;

      case "GUILD_AUDIT_LOG_ENTRY_CREATE":
        if (data.guild_id === GUILD_ID) {
          await this.scoreAuditEntry(data);
        }
        break;
    }
  }

  // ─── Raid scoring ────────────────────────────────────────────────────────────

  private async scoreJoin(member: any) {
    const now = Date.now();
    const user = member.user;
    const createdAt = snowflakeToTimestamp(user.id);
    const accountAgeMs = now - createdAt;

    let score = 0;
    const reasons: string[] = [];

    if (accountAgeMs < 24 * 60 * 60 * 1000) {
      score += 3;
      reasons.push("account < 24h old");
    } else if (accountAgeMs < 7 * 24 * 60 * 60 * 1000) {
      score += 2;
      reasons.push("account < 7d old");
    }

    if (!user.avatar) {
      score += 1;
      reasons.push("no avatar");
    }

    if (/\d{4,}$/.test(user.username)) {
      score += 1;
      reasons.push("generic digit-heavy username");
    }

    this.raidScores.push({
      timestamp: now,
      score,
      discordUserId: user.id,
      avatarHash: user.avatar ?? null,
      reasons,
    });
    this.pruneRaidScores(now);

    const windowTotal = this.raidScores.reduce((sum, e) => sum + e.score, 0);
    const rawJoinCount = this.raidScores.length;

    // Shared avatar hash — a strong bot-generator tell: distinct users
    // joining with byte-identical avatar hashes in the same window.
    // Only non-null hashes count; a shared "no avatar" default isn't
    // meaningful since huge numbers of legitimate users have none.
    const avatarHashCounts = new Map<string, number>();
    for (const e of this.raidScores) {
      if (!e.avatarHash) continue;
      avatarHashCounts.set(e.avatarHash, (avatarHashCounts.get(e.avatarHash) ?? 0) + 1);
    }
    const sharedAvatarHash = [...avatarHashCounts.entries()].find(
      ([, count]) => count >= AVATAR_HASH_SHARE_THRESHOLD
    );

    // Three independent triggers, ORed together — a raid using
    // older/normal-looking accounts might never build a high score,
    // but a raw join-velocity spike or reused-avatar cluster still
    // gives it away.
    if (
      windowTotal >= RAID_SCORE_THRESHOLD ||
      rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD ||
      sharedAvatarHash
    ) {
      const reasons: string[] = [];
      if (windowTotal >= RAID_SCORE_THRESHOLD) {
        reasons.push(`raid score ${windowTotal} reached in ${RAID_WINDOW_MS / 1000}s window`);
      }
      if (rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD) {
        reasons.push(`${rawJoinCount} raw joins in ${RAID_WINDOW_MS / 1000}s window`);
      }
      if (sharedAvatarHash) {
        reasons.push(
          `${sharedAvatarHash[1]} joiners sharing avatar hash ${sharedAvatarHash[0].slice(0, 8)}...`
        );
      }

      // Only ban accounts that actually looked suspicious individually
      // (score > 0), or that are part of the shared-avatar-hash
      // cluster specifically -- not every account that merely happened
      // to join in the same window as a raid. A join-count-velocity
      // trigger with several score-0 legitimate joiners mixed in
      // shouldn't catch those innocent accounts in the ban.
      const sharedHashValue = sharedAvatarHash?.[0];
      const actorIds = this.raidScores
        .filter((e) => e.score > 0 || (sharedHashValue && e.avatarHash === sharedHashValue))
        .map((e) => e.discordUserId);

      await this.respondToThreat("raid", {
        reason: reasons.join("; "),
        score: windowTotal,
        actorIds,
        detail: { joins: this.raidScores },
      });
      this.raidScores = [];
    }
  }

  private pruneRaidScores(now: number) {
    this.raidScores = this.raidScores.filter((e) => now - e.timestamp <= RAID_WINDOW_MS);
  }

  // ─── Nuke scoring ────────────────────────────────────────────────────────────

  private async scoreAuditEntry(entry: any) {
    // Bot self-removal protection — only OWNER_DISCORD_ID may remove
    // PitBoss from this guild. Runs before self-exclusion and the
    // whitelist bypass below, since a whitelisted co-owner attempting
    // this must still be caught. Detection/alert only, not
    // prevention — see the note on OWNER_DISCORD_ID above regarding
    // Discord role hierarchy being the actual blocking control.
    if (
      (entry.action_type === AUDIT_ACTION.MEMBER_KICK ||
        entry.action_type === AUDIT_ACTION.MEMBER_BAN_ADD) &&
      entry.target_id === this.env.DISCORD_APP_ID &&
      entry.user_id !== OWNER_DISCORD_ID
    ) {
      await this.respondToThreat("nuke", {
        reason: `Unauthorized attempt to remove PitBoss from the guild by <@${entry.user_id}> — only the owner may do this`,
        actorIds: [entry.user_id],
        detail: { entry },
      });
      return;
    }

    // Hard self-exclusion — PitBoss's own bot user must never be
    // scored against its own detector. This is checked before any
    // other logic runs, not configured as an editable whitelist entry.
    if (entry.user_id === this.env.DISCORD_APP_ID) return;

    // Trusted staff exclusion — legitimate bulk moderation by a
    // commissioner/head steward shouldn't look identical to a nuke.
    if (WHITELISTED_ACTOR_IDS.includes(entry.user_id)) return;

    const now = Date.now();
    const actorId = entry.user_id as string;
    const actionType = entry.action_type as number;

    // Zero-tolerance triggers — no window, no accumulation. Thresholds
    // named explicitly (both = 1) for consistency with the windowed
    // triggers below, even though behavior is unchanged from before.
    if (actionType === AUDIT_ACTION.WEBHOOK_CREATE) {
      const reason = `Webhook created by non-whitelisted actor (threshold: ${NUKE_WEBHOOK_THRESHOLD})`;
      await this.respondToThreat("nuke", {
        reason,
        actorIds: [actorId],
        detail: { entry },
      });
      await this.recordBannedId(actorId, "webhook_create", reason);
      return;
    }

    if (actionType === AUDIT_ACTION.BOT_ADD) {
      const reason = `Bot/integration added by non-whitelisted actor (threshold: ${NUKE_BOT_ADD_THRESHOLD})`;
      await this.respondToThreat("nuke", {
        reason,
        actorIds: [actorId],
        detail: { entry },
      });
      await this.recordBannedId(actorId, "bot_add", reason);
      return;
    }

    if (actionType === AUDIT_ACTION.GUILD_UPDATE) {
      const dangerous = this.guildUpdateIsDangerous(entry);
      if (dangerous) {
        await this.respondToThreat("nuke", {
          reason: dangerous,
          actorIds: [actorId],
          detail: { entry },
        });
        return;
      }
    }

    if (actionType === AUDIT_ACTION.ROLE_UPDATE) {
      const grantedDangerous = this.roleUpdateGrantsDangerousPermission(entry);
      if (grantedDangerous) {
        await this.respondToThreat("nuke", {
          reason: `Dangerous permission grant: ${grantedDangerous.join(", ")}`,
          actorIds: [actorId],
          detail: { entry },
        });
        return;
      }
    }

    // Windowed, per-actor triggers.
    if (
      actionType === AUDIT_ACTION.CHANNEL_DELETE ||
      actionType === AUDIT_ACTION.ROLE_DELETE ||
      actionType === AUDIT_ACTION.MEMBER_BAN_ADD ||
      actionType === AUDIT_ACTION.MEMBER_KICK ||
      actionType === AUDIT_ACTION.CHANNEL_CREATE ||
      actionType === AUDIT_ACTION.ROLE_CREATE ||
      actionType === AUDIT_ACTION.MEMBER_ROLE_UPDATE
    ) {
      const existing = this.nukeActionsByActor.get(actorId) ?? [];
      existing.push({ timestamp: now, actionType });
      const pruned = existing.filter((e) => now - e.timestamp <= NUKE_WINDOW_MS);
      this.nukeActionsByActor.set(actorId, pruned);

      const deleteCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.CHANNEL_DELETE || e.actionType === AUDIT_ACTION.ROLE_DELETE
      ).length;
      const banKickCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.MEMBER_BAN_ADD || e.actionType === AUDIT_ACTION.MEMBER_KICK
      ).length;
      const createCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.CHANNEL_CREATE || e.actionType === AUDIT_ACTION.ROLE_CREATE
      ).length;
      const roleGrantCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.MEMBER_ROLE_UPDATE
      ).length;

      if (deleteCount >= NUKE_DELETE_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${deleteCount} channel/role deletions by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: deleteCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (banKickCount >= NUKE_BAN_KICK_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${banKickCount} bans/kicks by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: banKickCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (createCount >= NUKE_CREATE_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${createCount} channel/role creations by one actor in ${NUKE_WINDOW_MS / 1000}s (spam)`,
          score: createCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (roleGrantCount >= NUKE_ROLE_GRANT_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${roleGrantCount} role grants to members by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: roleGrantCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      }
    }
  }

  private guildUpdateIsDangerous(entry: any): string | null {
    const changes = entry.changes ?? [];

    const verificationChange = changes.find((c: any) => c.key === "verification_level");
    if (
      verificationChange &&
      typeof verificationChange.new_value === "number" &&
      typeof verificationChange.old_value === "number" &&
      verificationChange.new_value < verificationChange.old_value
    ) {
      return `Verification level lowered (${verificationChange.old_value} → ${verificationChange.new_value})`;
    }

    const ownerChange = changes.find((c: any) => c.key === "owner_id");
    if (ownerChange) {
      return `Server ownership transferred to <@${ownerChange.new_value}>`;
    }

    return null;
  }

  private roleUpdateGrantsDangerousPermission(entry: any): string[] | null {
    const permsChange = entry.changes?.find((c: any) => c.key === "permissions");
    if (!permsChange || !permsChange.new_value) return null;

    const newPerms = BigInt(permsChange.new_value);
    const oldPerms = BigInt(permsChange.old_value ?? "0");
    const granted: string[] = [];

    for (const [name, bit] of Object.entries(DANGEROUS_PERMISSIONS)) {
      const hasNow = (newPerms & bit) !== 0n;
      const hadBefore = (oldPerms & bit) !== 0n;
      if (hasNow && !hadBefore) granted.push(name);
    }

    return granted.length > 0 ? granted : null;
  }

  // ─── Response: the "all" mode — every action fires together ──────────────────

  private async respondToThreat(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[]; detail: unknown }
  ) {
    console.log(`[guardian] THREAT DETECTED (${type}):`, ctx.reason);

    // Fire all four concurrently — none should block or skip the
    // others if one fails (e.g. a ban failing shouldn't stop the
    // alert from posting).
    const results = await Promise.allSettled([
      this.autoPunish(ctx.actorIds),
      this.autoLockdown(type, ctx),
      this.alertSteward(type, ctx),
      this.logEvent(type, ctx),
    ]);

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const labels = ["autoPunish", "autoLockdown", "alertSteward", "logEvent"];
        console.error(`[guardian] ${labels[i]} failed:`, result.reason);
      }
    }
  }

  private async autoPunish(actorIds: string[]) {
    for (const userId of actorIds) {
      await this.banWithRetry(userId);
    }
  }

  // Bans a single user, retrying once on a 429 by honoring Discord's
  // retry_after. Auto-punish runs on exactly the scenario (banning a
  // dozen+ raid accounts in a burst) most likely to hit a rate limit,
  // so a bare unhandled 429 would silently drop bans right when it
  // matters most.
  private async banWithRetry(userId: string, attempt = 0): Promise<void> {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          delete_message_seconds: 3600, // clean up an hour of messages, in case it's spam
        }),
      }
    );

    if (res.ok) return;

    if (res.status === 429 && attempt < 2) {
      let retryAfterMs = 1000;
      try {
        const body: any = await res.clone().json();
        if (typeof body.retry_after === "number") {
          retryAfterMs = Math.ceil(body.retry_after * 1000);
        }
      } catch {
        // fall back to the header if the body isn't JSON for some reason
        const headerVal = res.headers.get("Retry-After");
        if (headerVal) retryAfterMs = Math.ceil(parseFloat(headerVal) * 1000);
      }
      console.error(`[guardian] ban rate-limited for ${userId}, retrying in ${retryAfterMs}ms`);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return this.banWithRetry(userId, attempt + 1);
    }

    console.error(`[guardian] ban failed for ${userId}:`, res.status, await res.text());
  }

  private async autoLockdown(
    type: "raid" | "nuke",
    ctx: { detail: unknown }
  ) {
    if (type === "raid") {
      // Raise verification level to the max and revoke active
      // invites — stops further unknown joiners without needing to
      // identify them individually.
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ verification_level: 4 }), // VERY_HIGH
      });

      const invitesRes = await fetch(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/invites`,
        { headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}` } }
      );
      if (invitesRes.ok) {
        const invites: any[] = await invitesRes.json();
        await Promise.all(
          invites.map((inv) =>
            fetch(`https://discord.com/api/v10/invites/${inv.code}`, {
              method: "DELETE",
              headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}` },
            })
          )
        );
      }
    } else {
      // Nuke: the actor is already banned via autoPunish. Where the
      // triggering entry was a dangerous permission grant, strip it
      // back off the role immediately rather than leaving a
      // still-dangerous role sitting around post-ban.
      const entries = (ctx.detail as any)?.entries ?? [(ctx.detail as any)?.entry];
      for (const entry of entries) {
        if (entry?.action_type === AUDIT_ACTION.ROLE_UPDATE && entry.target_id) {
          const permsChange = entry.changes?.find((c: any) => c.key === "permissions");
          if (permsChange?.old_value !== undefined) {
            await fetch(
              `https://discord.com/api/v10/guilds/${GUILD_ID}/roles/${entry.target_id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ permissions: permsChange.old_value }),
              }
            );
          }
        }
      }
    }
  }

  private async alertSteward(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[] }
  ) {
    if (ALERTS_CHANNEL_ID.startsWith("REPLACE_")) {
      console.error("[guardian] ALERTS_CHANNEL_ID not configured — skipping Discord alert");
      await this.dmBackupContacts(type, ctx);
      return;
    }

    const emoji = type === "raid" ? "🚨" : "💣";
    const lines = [
      `${emoji} <@&${STEWARD_ROLE_ID}> **${type.toUpperCase()} DETECTED**`,
      ctx.reason,
      ctx.actorIds.length > 0
        ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}`
        : null,
      `Auto-lockdown applied. Full detail logged.`,
    ].filter(Boolean);

    const res = await fetch(`https://discord.com/api/v10/channels/${ALERTS_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: lines.join("\n") }),
    });

    // Falls back to DMing backup contacts if the primary alert channel
    // post fails — most likely because a nuke deleted the channel out
    // from under us, which is exactly when the alert matters most.
    if (!res.ok) {
      console.error("[guardian] alert channel post failed:", res.status, await res.text());
      await this.dmBackupContacts(type, ctx, lines.join("\n"));
    }
  }

  private async dmBackupContacts(
    type: "raid" | "nuke",
    ctx: { reason: string; actorIds: string[] },
    preformattedContent?: string
  ) {
    if (BACKUP_ALERT_DISCORD_IDS.length === 0) return;

    const content =
      preformattedContent ??
      [
        `**${type.toUpperCase()} DETECTED** (backup alert — primary alert channel unreachable)`,
        ctx.reason,
        ctx.actorIds.length > 0
          ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

    await Promise.all(
      BACKUP_ALERT_DISCORD_IDS.map((discordId) => this.sendBackupDirectMessage(discordId, content))
    );
  }

  private async sendBackupDirectMessage(discordUserId: string, content: string): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();

    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });

    if (!dmRes.ok) {
      console.error("[guardian] backup DM channel open failed:", dmRes.status, await dmRes.text());
      return;
    }

    const dmChannel = await dmRes.json();

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!msgRes.ok) {
      console.error("[guardian] backup DM send failed:", msgRes.status, await msgRes.text());
    }
  }

  private async logEvent(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[]; detail: unknown }
  ) {
    await fetch(`${this.env.SUPABASE_URL}/rest/v1/security_events`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        guild_id: GUILD_ID,
        event_type: type,
        trigger_reason: ctx.reason,
        actor_discord_id: ctx.actorIds[0] ?? null,
        score: ctx.score ?? null,
        action_taken: "ban+lockdown+alert",
        detail: { actorIds: ctx.actorIds, ...(ctx.detail as object) },
      }),
    });
  }

  // Records the Discord ID of a webhook-create or bot-add violator
  // into pitboss.guardian_banned_ids -- a standalone, simply-queryable
  // list of banned IDs for these two triggers specifically, separate
  // from the general security_events log.
  private async recordBannedId(
    discordId: string,
    triggerType: "webhook_create" | "bot_add",
    reason: string
  ) {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/guardian_banned_ids`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        discord_id: discordId,
        guild_id: GUILD_ID,
        trigger_type: triggerType,
        reason,
      }),
    });
    if (!res.ok) {
      console.error("[guardian] recordBannedId failed:", res.status, await res.text());
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
}

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

// Actions by these Discord user IDs are never scored as raid/nuke
// triggers — meant for commissioners/head stewards who legitimately
// do bulk moderation (mass bans, role cleanups) that would otherwise
// look identical to a nuke. Does NOT exempt them from the bot
// self-removal protection below — that check runs first and applies
// regardless of whitelist status.
const WHITELISTED_ACTOR_IDS: string[] = [
  "1047084061027471480", // truthexperience (owner)
  "1401841577478848603", // _colapintolover (co-owner)
  "1248351138302922883", // yello_y (co-owner)
];

// Direct-message fallback recipients if posting to ALERTS_CHANNEL_ID
// fails — most likely because the channel itself was a casualty of
// the nuke.
const BACKUP_ALERT_DISCORD_IDS: string[] = [
  "1047084061027471480", // truthexperience (owner)
  "1401841577478848603", // _colapintolover (co-owner)
  "1248351138302922883", // yello_y (co-owner)
];

// Only this account may remove PitBoss from the guild. Co-owners are
// whitelisted for everything else above, but NOT for this — see the
// self-protection check at the top of scoreAuditEntry, which runs
// before the whitelist bypass. Note this is detection/alert only, not
// prevention: Discord processes a kick/ban before any Gateway event
// reaches us, so if it succeeds we lose guild access entirely (only
// the DM-to-backup-contacts and Supabase logging still work
// afterward, since neither needs guild access). The actual preventive
// control is Discord's own role hierarchy — keep PitBoss's role
// positioned ABOVE both co-owner roles in Server Settings > Roles;
// only the true guild owner can kick/ban a member whose top role
// outranks their own, regardless of KICK_MEMBERS/BAN_MEMBERS perms.
const OWNER_DISCORD_ID = "1047084061027471480"; // truthexperience

// ─── Scoring thresholds ────────────────────────────────────────────────────────

const RAID_WINDOW_MS = 60_000;
const RAID_SCORE_THRESHOLD = 10;
const RAID_JOIN_COUNT_THRESHOLD = 8; // raw joins in-window, independent of score
const AVATAR_HASH_SHARE_THRESHOLD = 3; // distinct users sharing one avatar hash

const NUKE_WINDOW_MS = 30_000;
const NUKE_DELETE_THRESHOLD = 3; // channel/role deletions by one actor
const NUKE_BAN_KICK_THRESHOLD = 5; // bans/kicks by one actor
const NUKE_CREATE_THRESHOLD = 5; // channel/role creations by one actor (spam)
const NUKE_ROLE_GRANT_THRESHOLD = 5; // role additions to members by one actor

// Discord audit log action types relevant here.
// https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events
const AUDIT_ACTION = {
  GUILD_UPDATE: 1,
  CHANNEL_CREATE: 10,
  CHANNEL_DELETE: 12,
  MEMBER_KICK: 20,
  MEMBER_BAN_ADD: 22,
  MEMBER_ROLE_UPDATE: 25,
  BOT_ADD: 28,
  ROLE_CREATE: 30,
  ROLE_UPDATE: 31,
  ROLE_DELETE: 32,
  WEBHOOK_CREATE: 50,
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
  avatarHash: string | null;
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

  // In-memory scoring windows. Short-lived (30-60s) by design, so
  // losing these on a DO restart/eviction is an acceptable tradeoff
  // versus the complexity of persisting a rolling window to storage.
  private raidScores: RaidScoreEntry[] = [];
  private nukeActionsByActor: Map<string, NukeActionEntry[]> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/start") {
      if (!this.ws || this.ws.readyState !== WebSocket.READY_STATE_OPEN) {
        await this.connectGateway();
        return new Response("Gateway connection starting.", { status: 200 });
      }
      return new Response("Already connected.", { status: 200 });
    }

    if (url.pathname === "/status") {
      const token = this.env.DISCORD_BOT_TOKEN ?? "";
      return Response.json({
        connected: this.ws?.readyState === WebSocket.READY_STATE_OPEN,
        sessionId: this.sessionId,
        sequence: this.sequence,
        raidScoreWindowSize: this.raidScores.length,
        nukeActorsTracked: this.nukeActionsByActor.size,
        // TEMPORARY diagnostic — kept intentionally for now. Never
        // logs the full token, only enough to confirm the secret's
        // shape matches what's expected (length, whether it
        // accidentally includes a "Bot " prefix, and a masked
        // first/last few characters for visual comparison against
        // the Discord Developer Portal).
        tokenDiagnostic: {
          length: token.length,
          startsWithBotPrefix: token.startsWith("Bot "),
          hasLeadingOrTrailingWhitespace: token !== token.trim(),
          preview: token.length > 10
            ? `${token.slice(0, 6)}...${token.slice(-4)}`
            : "(too short to preview)",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── Gateway connection ─────────────────────────────────────────────────────

  private async connectGateway(resumeUrl?: string) {
    // fetch() does not accept ws:// or wss:// as a URL scheme — it throws
    // a TypeError immediately if given one. The Upgrade: websocket header
    // is what actually signals the protocol switch; the URL itself must
    // use http(s). Discord's gateway URLs (both the initial endpoint and
    // resume_gateway_url from READY) come in wss:// form, so they need
    // converting here before being passed to fetch().
    const rawUrl = resumeUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    const gatewayUrl = rawUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

    const res = await fetch(gatewayUrl, {
      headers: { Upgrade: "websocket" },
    });

    const ws = res.webSocket;
    if (!ws) {
      console.error("[guardian] Gateway upgrade failed — no webSocket on response");
      // Retry after a delay rather than looping tightly.
      await this.scheduleReconnect(5000);
      return;
    }

    ws.accept();
    this.ws = ws;

    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("close", (event) => this.handleClose(event));
    ws.addEventListener("error", (event) => {
      console.error("[guardian] WebSocket error:", event);
    });
  }

  private async handleMessage(event: MessageEvent) {
    const payload = JSON.parse(event.data as string);
    const { op, d, s, t } = payload;

    if (s !== null && s !== undefined) this.sequence = s;

    switch (op) {
      case 10: // HELLO
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.resumeGatewayUrl) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case 11: // HEARTBEAT_ACK
        this.heartbeatAckReceived = true;
        break;

      case 0: // DISPATCH
        await this.handleDispatch(t, d);
        break;

      case 7: // RECONNECT
        this.ws?.close(4000, "reconnect requested");
        break;

      case 9: // INVALID_SESSION
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        // Discord asks for a short random delay before re-identifying.
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));
        this.sendIdentify();
        break;
    }
  }

  private sendIdentify() {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.env.DISCORD_BOT_TOKEN?.trim(),
          intents:
            (1 << 1) | // GUILD_MEMBERS (required for GUILD_MEMBER_ADD)
            (1 << 2), // GUILD_MODERATION (ban add/remove events; audit-log-adjacent)
          properties: {
            os: "cloudflare-workers",
            browser: "pitboss-guardian",
            device: "pitboss-guardian",
          },
        },
      })
    );
  }

  private sendResume() {
    this.ws?.send(
      JSON.stringify({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN?.trim(),
          session_id: this.sessionId,
          seq: this.sequence,
        },
      })
    );
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatAckReceived = true;

    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        // Missed the previous ACK — connection is dead, force a
        // reconnect rather than keep sending into the void.
        console.error("[guardian] Heartbeat ACK missed — reconnecting");
        this.ws?.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAckReceived = false;
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
    }, intervalMs) as unknown as number;
  }

  private async handleClose(event: CloseEvent) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    console.error("[guardian] Gateway closed:", event.code, event.reason);

    // Codes that mean "don't try to resume, start fresh."
    const noResumeCodes = [4004, 4010, 4011, 4012, 4013, 4014];
    if (noResumeCodes.includes(event.code)) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
    }

    await this.scheduleReconnect(2000 + Math.random() * 3000);
  }

  private async scheduleReconnect(delayMs: number) {
    await new Promise((r) => setTimeout(r, delayMs));
    await this.connectGateway(this.resumeGatewayUrl ?? undefined);
  }

  // ─── Dispatch handling ───────────────────────────────────────────────────────

  private async handleDispatch(type: string, data: any) {
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        console.log("[guardian] READY — session established");
        break;

      case "RESUMED":
        console.log("[guardian] Session resumed");
        break;

      case "GUILD_MEMBER_ADD":
        if (data.guild_id === GUILD_ID) {
          await this.scoreJoin(data);
        }
        break;

      case "GUILD_AUDIT_LOG_ENTRY_CREATE":
        if (data.guild_id === GUILD_ID) {
          await this.scoreAuditEntry(data);
        }
        break;
    }
  }

  // ─── Raid scoring ────────────────────────────────────────────────────────────

  private async scoreJoin(member: any) {
    const now = Date.now();
    const user = member.user;
    const createdAt = snowflakeToTimestamp(user.id);
    const accountAgeMs = now - createdAt;

    let score = 0;
    const reasons: string[] = [];

    if (accountAgeMs < 24 * 60 * 60 * 1000) {
      score += 3;
      reasons.push("account < 24h old");
    } else if (accountAgeMs < 7 * 24 * 60 * 60 * 1000) {
      score += 2;
      reasons.push("account < 7d old");
    }

    if (!user.avatar) {
      score += 1;
      reasons.push("no avatar");
    }

    if (/\d{4,}$/.test(user.username)) {
      score += 1;
      reasons.push("generic digit-heavy username");
    }

    this.raidScores.push({
      timestamp: now,
      score,
      discordUserId: user.id,
      avatarHash: user.avatar ?? null,
      reasons,
    });
    this.pruneRaidScores(now);

    const windowTotal = this.raidScores.reduce((sum, e) => sum + e.score, 0);
    const rawJoinCount = this.raidScores.length;

    // Shared avatar hash — a strong bot-generator tell: distinct users
    // joining with byte-identical avatar hashes in the same window.
    // Only non-null hashes count; a shared "no avatar" default isn't
    // meaningful since huge numbers of legitimate users have none.
    const avatarHashCounts = new Map<string, number>();
    for (const e of this.raidScores) {
      if (!e.avatarHash) continue;
      avatarHashCounts.set(e.avatarHash, (avatarHashCounts.get(e.avatarHash) ?? 0) + 1);
    }
    const sharedAvatarHash = [...avatarHashCounts.entries()].find(
      ([, count]) => count >= AVATAR_HASH_SHARE_THRESHOLD
    );

    // Three independent triggers, ORed together — a raid using
    // older/normal-looking accounts might never build a high score,
    // but a raw join-velocity spike or reused-avatar cluster still
    // gives it away.
    if (
      windowTotal >= RAID_SCORE_THRESHOLD ||
      rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD ||
      sharedAvatarHash
    ) {
      const reasons: string[] = [];
      if (windowTotal >= RAID_SCORE_THRESHOLD) {
        reasons.push(`raid score ${windowTotal} reached in ${RAID_WINDOW_MS / 1000}s window`);
      }
      if (rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD) {
        reasons.push(`${rawJoinCount} raw joins in ${RAID_WINDOW_MS / 1000}s window`);
      }
      if (sharedAvatarHash) {
        reasons.push(
          `${sharedAvatarHash[1]} joiners sharing avatar hash ${sharedAvatarHash[0].slice(0, 8)}...`
        );
      }

      await this.respondToThreat("raid", {
        reason: reasons.join("; "),
        score: windowTotal,
        // Ban every account that contributed to this window, not just
        // the one that tipped it over — they're all part of the same
        // burst.
        actorIds: this.raidScores.map((e) => e.discordUserId),
        detail: { joins: this.raidScores },
      });
      this.raidScores = [];
    }
  }

  private pruneRaidScores(now: number) {
    this.raidScores = this.raidScores.filter((e) => now - e.timestamp <= RAID_WINDOW_MS);
  }

  // ─── Nuke scoring ────────────────────────────────────────────────────────────

  private async scoreAuditEntry(entry: any) {
    // Bot self-removal protection — only OWNER_DISCORD_ID may remove
    // PitBoss from this guild. Runs before self-exclusion and the
    // whitelist bypass below, since a whitelisted co-owner attempting
    // this must still be caught. Detection/alert only, not
    // prevention — see the note on OWNER_DISCORD_ID above regarding
    // Discord role hierarchy being the actual blocking control.
    if (
      (entry.action_type === AUDIT_ACTION.MEMBER_KICK ||
        entry.action_type === AUDIT_ACTION.MEMBER_BAN_ADD) &&
      entry.target_id === this.env.DISCORD_APP_ID &&
      entry.user_id !== OWNER_DISCORD_ID
    ) {
      await this.respondToThreat("nuke", {
        reason: `Unauthorized attempt to remove PitBoss from the guild by <@${entry.user_id}> — only the owner may do this`,
        actorIds: [entry.user_id],
        detail: { entry },
      });
      return;
    }

    // Hard self-exclusion — PitBoss's own bot user must never be
    // scored against its own detector. This is checked before any
    // other logic runs, not configured as an editable whitelist entry.
    if (entry.user_id === this.env.DISCORD_APP_ID) return;

    // Trusted staff exclusion — legitimate bulk moderation by a
    // commissioner/head steward shouldn't look identical to a nuke.
    if (WHITELISTED_ACTOR_IDS.includes(entry.user_id)) return;

    const now = Date.now();
    const actorId = entry.user_id as string;
    const actionType = entry.action_type as number;

    // Zero-tolerance triggers — no window, no accumulation.
    if (actionType === AUDIT_ACTION.WEBHOOK_CREATE) {
      await this.respondToThreat("nuke", {
        reason: `Webhook created by non-whitelisted actor`,
        actorIds: [actorId],
        detail: { entry },
      });
      return;
    }

    if (actionType === AUDIT_ACTION.BOT_ADD) {
      await this.respondToThreat("nuke", {
        reason: `Bot/integration added by non-whitelisted actor`,
        actorIds: [actorId],
        detail: { entry },
      });
      return;
    }

    if (actionType === AUDIT_ACTION.GUILD_UPDATE) {
      const dangerous = this.guildUpdateIsDangerous(entry);
      if (dangerous) {
        await this.respondToThreat("nuke", {
          reason: dangerous,
          actorIds: [actorId],
          detail: { entry },
        });
        return;
      }
    }

    if (actionType === AUDIT_ACTION.ROLE_UPDATE) {
      const grantedDangerous = this.roleUpdateGrantsDangerousPermission(entry);
      if (grantedDangerous) {
        await this.respondToThreat("nuke", {
          reason: `Dangerous permission grant: ${grantedDangerous.join(", ")}`,
          actorIds: [actorId],
          detail: { entry },
        });
        return;
      }
    }

    // Windowed, per-actor triggers.
    if (
      actionType === AUDIT_ACTION.CHANNEL_DELETE ||
      actionType === AUDIT_ACTION.ROLE_DELETE ||
      actionType === AUDIT_ACTION.MEMBER_BAN_ADD ||
      actionType === AUDIT_ACTION.MEMBER_KICK ||
      actionType === AUDIT_ACTION.CHANNEL_CREATE ||
      actionType === AUDIT_ACTION.ROLE_CREATE ||
      actionType === AUDIT_ACTION.MEMBER_ROLE_UPDATE
    ) {
      const existing = this.nukeActionsByActor.get(actorId) ?? [];
      existing.push({ timestamp: now, actionType });
      const pruned = existing.filter((e) => now - e.timestamp <= NUKE_WINDOW_MS);
      this.nukeActionsByActor.set(actorId, pruned);

      const deleteCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.CHANNEL_DELETE || e.actionType === AUDIT_ACTION.ROLE_DELETE
      ).length;
      const banKickCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.MEMBER_BAN_ADD || e.actionType === AUDIT_ACTION.MEMBER_KICK
      ).length;
      const createCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.CHANNEL_CREATE || e.actionType === AUDIT_ACTION.ROLE_CREATE
      ).length;
      const roleGrantCount = pruned.filter(
        (e) => e.actionType === AUDIT_ACTION.MEMBER_ROLE_UPDATE
      ).length;

      if (deleteCount >= NUKE_DELETE_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${deleteCount} channel/role deletions by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: deleteCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (banKickCount >= NUKE_BAN_KICK_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${banKickCount} bans/kicks by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: banKickCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (createCount >= NUKE_CREATE_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${createCount} channel/role creations by one actor in ${NUKE_WINDOW_MS / 1000}s (spam)`,
          score: createCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      } else if (roleGrantCount >= NUKE_ROLE_GRANT_THRESHOLD) {
        await this.respondToThreat("nuke", {
          reason: `${roleGrantCount} role grants to members by one actor in ${NUKE_WINDOW_MS / 1000}s`,
          score: roleGrantCount,
          actorIds: [actorId],
          detail: { entries: pruned },
        });
        this.nukeActionsByActor.delete(actorId);
      }
    }
  }

  private guildUpdateIsDangerous(entry: any): string | null {
    const changes = entry.changes ?? [];

    const verificationChange = changes.find((c: any) => c.key === "verification_level");
    if (
      verificationChange &&
      typeof verificationChange.new_value === "number" &&
      typeof verificationChange.old_value === "number" &&
      verificationChange.new_value < verificationChange.old_value
    ) {
      return `Verification level lowered (${verificationChange.old_value} → ${verificationChange.new_value})`;
    }

    const ownerChange = changes.find((c: any) => c.key === "owner_id");
    if (ownerChange) {
      return `Server ownership transferred to <@${ownerChange.new_value}>`;
    }

    return null;
  }

  private roleUpdateGrantsDangerousPermission(entry: any): string[] | null {
    const permsChange = entry.changes?.find((c: any) => c.key === "permissions");
    if (!permsChange || !permsChange.new_value) return null;

    const newPerms = BigInt(permsChange.new_value);
    const oldPerms = BigInt(permsChange.old_value ?? "0");
    const granted: string[] = [];

    for (const [name, bit] of Object.entries(DANGEROUS_PERMISSIONS)) {
      const hasNow = (newPerms & bit) !== 0n;
      const hadBefore = (oldPerms & bit) !== 0n;
      if (hasNow && !hadBefore) granted.push(name);
    }

    return granted.length > 0 ? granted : null;
  }

  // ─── Response: the "all" mode — every action fires together ──────────────────

  private async respondToThreat(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[]; detail: unknown }
  ) {
    console.log(`[guardian] THREAT DETECTED (${type}):`, ctx.reason);

    // Fire all four concurrently — none should block or skip the
    // others if one fails (e.g. a ban failing shouldn't stop the
    // alert from posting).
    const results = await Promise.allSettled([
      this.autoPunish(ctx.actorIds),
      this.autoLockdown(type, ctx),
      this.alertSteward(type, ctx),
      this.logEvent(type, ctx),
    ]);

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const labels = ["autoPunish", "autoLockdown", "alertSteward", "logEvent"];
        console.error(`[guardian] ${labels[i]} failed:`, result.reason);
      }
    }
  }

  private async autoPunish(actorIds: string[]) {
    for (const userId of actorIds) {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            delete_message_seconds: 3600, // clean up an hour of messages, in case it's spam
          }),
        }
      );
      if (!res.ok) {
        console.error(`[guardian] ban failed for ${userId}:`, res.status, await res.text());
      }
    }
  }

  private async autoLockdown(
    type: "raid" | "nuke",
    ctx: { detail: unknown }
  ) {
    if (type === "raid") {
      // Raise verification level to the max and revoke active
      // invites — stops further unknown joiners without needing to
      // identify them individually.
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ verification_level: 4 }), // VERY_HIGH
      });

      const invitesRes = await fetch(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/invites`,
        { headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}` } }
      );
      if (invitesRes.ok) {
        const invites: any[] = await invitesRes.json();
        await Promise.all(
          invites.map((inv) =>
            fetch(`https://discord.com/api/v10/invites/${inv.code}`, {
              method: "DELETE",
              headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}` },
            })
          )
        );
      }
    } else {
      // Nuke: the actor is already banned via autoPunish. Where the
      // triggering entry was a dangerous permission grant, strip it
      // back off the role immediately rather than leaving a
      // still-dangerous role sitting around post-ban.
      const entries = (ctx.detail as any)?.entries ?? [(ctx.detail as any)?.entry];
      for (const entry of entries) {
        if (entry?.action_type === AUDIT_ACTION.ROLE_UPDATE && entry.target_id) {
          const permsChange = entry.changes?.find((c: any) => c.key === "permissions");
          if (permsChange?.old_value !== undefined) {
            await fetch(
              `https://discord.com/api/v10/guilds/${GUILD_ID}/roles/${entry.target_id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ permissions: permsChange.old_value }),
              }
            );
          }
        }
      }
    }
  }

  private async alertSteward(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[] }
  ) {
    if (ALERTS_CHANNEL_ID.startsWith("REPLACE_")) {
      console.error("[guardian] ALERTS_CHANNEL_ID not configured — skipping Discord alert");
      await this.dmBackupContacts(type, ctx);
      return;
    }

    const emoji = type === "raid" ? "🚨" : "💣";
    const lines = [
      `${emoji} <@&${STEWARD_ROLE_ID}> **${type.toUpperCase()} DETECTED**`,
      ctx.reason,
      ctx.actorIds.length > 0
        ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}`
        : null,
      `Auto-lockdown applied. Full detail logged.`,
    ].filter(Boolean);

    const res = await fetch(`https://discord.com/api/v10/channels/${ALERTS_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: lines.join("\n") }),
    });

    // Falls back to DMing backup contacts if the primary alert channel
    // post fails — most likely because a nuke deleted the channel out
    // from under us, which is exactly when the alert matters most.
    if (!res.ok) {
      console.error("[guardian] alert channel post failed:", res.status, await res.text());
      await this.dmBackupContacts(type, ctx, lines.join("\n"));
    }
  }

  private async dmBackupContacts(
    type: "raid" | "nuke",
    ctx: { reason: string; actorIds: string[] },
    preformattedContent?: string
  ) {
    if (BACKUP_ALERT_DISCORD_IDS.length === 0) return;

    const content =
      preformattedContent ??
      [
        `**${type.toUpperCase()} DETECTED** (backup alert — primary alert channel unreachable)`,
        ctx.reason,
        ctx.actorIds.length > 0
          ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

    await Promise.all(
      BACKUP_ALERT_DISCORD_IDS.map((discordId) => this.sendBackupDirectMessage(discordId, content))
    );
  }

  private async sendBackupDirectMessage(discordUserId: string, content: string): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();

    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });

    if (!dmRes.ok) {
      console.error("[guardian] backup DM channel open failed:", dmRes.status, await dmRes.text());
      return;
    }

    const dmChannel = await dmRes.json();

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!msgRes.ok) {
      console.error("[guardian] backup DM send failed:", msgRes.status, await msgRes.text());
    }
  }

  private async logEvent(
    type: "raid" | "nuke",
    ctx: { reason: string; score?: number; actorIds: string[]; detail: unknown }
  ) {
    await fetch(`${this.env.SUPABASE_URL}/rest/v1/security_events`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        guild_id: GUILD_ID,
        event_type: type,
        trigger_reason: ctx.reason,
        actor_discord_id: ctx.actorIds[0] ?? null,
        score: ctx.score ?? null,
        action_taken: "ban+lockdown+alert",
        detail: { actorIds: ctx.actorIds, ...(ctx.detail as object) },
      }),
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
}
