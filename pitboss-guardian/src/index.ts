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
      return Response.json({
        connected: this.ws?.readyState === WebSocket.READY_STATE_OPEN,
        sessionId: this.sessionId,
        sequence: this.sequence,
        raidScoreWindowSize: this.raidScores.length,
        nukeActorsTracked: this.nukeActionsByActor.size,
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
          token: this.env.DISCORD_BOT_TOKEN,
          intents:
            (1 << 1) | // GUILD_MEMBERS (required for GUILD_MEMBER_ADD)
            (1 << 7), // GUILD_MODERATION (ban add/remove events; audit-log-adjacent)
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
          token: this.env.DISCORD_BOT_TOKEN,
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

    this.raidScores.push({ timestamp: now, score, discordUserId: user.id, reasons });
    this.pruneRaidScores(now);

    const windowTotal = this.raidScores.reduce((sum, e) => sum + e.score, 0);

    if (windowTotal >= RAID_SCORE_THRESHOLD) {
      await this.respondToThreat("raid", {
        reason: `Raid score ${windowTotal} reached in ${RAID_WINDOW_MS / 1000}s window (${this.raidScores.length} joins scored)`,
        score: windowTotal,
        // Ban every account that contributed to this window's score,
        // not just the one that tipped it over — they're all part of
        // the same burst.
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
    // Hard self-exclusion — PitBoss's own bot user must never be
    // scored against its own detector. This is checked before any
    // other logic runs, not configured as an editable whitelist entry.
    if (entry.user_id === this.env.DISCORD_APP_ID) return;

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
      actionType === AUDIT_ACTION.MEMBER_KICK
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
      }
    }
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
            Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
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
          Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ verification_level: 4 }), // VERY_HIGH
      });

      const invitesRes = await fetch(
        `https://discord.com/api/v10/guilds/${GUILD_ID}/invites`,
        { headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` } }
      );
      if (invitesRes.ok) {
        const invites: any[] = await invitesRes.json();
        await Promise.all(
          invites.map((inv) =>
            fetch(`https://discord.com/api/v10/invites/${inv.code}`, {
              method: "DELETE",
              headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
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
                  Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
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

    await fetch(`https://discord.com/api/v10/channels/${ALERTS_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: lines.join("\n") }),
    });
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
