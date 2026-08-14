// pitboss-guardian — multi-tenant anti-raid / anti-nuke worker
//
// CHANGE FROM PREVIOUS VERSION: no more hardcoded GUILD_ID / STEWARD_ROLE_ID /
// ALERTS_CHANNEL_ID / WHITELISTED_ACTOR_IDS constants. Every guild the bot is
// a member of gets auto-provisioned on GUILD_CREATE (fires on first join AND
// on every gateway reconnect for guilds already joined), and its config is
// persisted to pitboss.guardian_guild_config so it survives DO restarts.
//
// One Durable Object instance ("guardian-singleton") holds the single Gateway
// connection for the whole bot — this is correct Discord architecture: one
// bot token gets one gateway session covering all its guilds, not one
// session per guild. Per-guild state (config, raid/nuke scoring windows) is
// kept in Maps keyed by guild_id inside that one instance.
//
// PATCH (review pass):
//   1. Added missing GUILDS intent bit — without it, GUILD_CREATE payloads
//      don't include populated roles/channels/members, so provisionGuild()
//      never had real data to auto-provision from. This was silently
//      breaking whitelist/steward-role/alerts-channel setup for every guild.
//   2. Stewards are now whitelisted alongside admins, so they don't get
//      auto-banned for doing their job during a real incident.
//   3. Delete-spam nukes now trigger the same guild-wide lockdown as raids,
//      instead of only reverting role-permission changes.
//
// PATCH (2026-08-14): every Supabase REST call below was missing the
// Accept-Profile / Content-Profile header needed to target the pitboss
// schema (guardian_guild_config, security_events, guardian_banned_ids all
// live in pitboss, not public — PostgREST defaults to public without an
// explicit profile header even though pitboss is in the exposed-schemas
// list). This was causing config load, config persistence, security event
// logging, and banned-ID recording to silently 404 in production.

var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const id = env.GUARDIAN.idFromName("guardian-singleton");
    const stub = env.GUARDIAN.get(id);

    const guardedPaths = ["/start", "/status", "/lockdown", "/endlockdown", "/guilds"];
    if (guardedPaths.includes(url.pathname)) {
      const provided = req.headers.get("X-Guardian-Key")?.trim();
      if (provided !== env.DISCORD_BOT_TOKEN?.trim()) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stub.fetch(req);
    }

    return new Response("pitboss-guardian", { status: 200 });
  },

  // Cron Trigger — fires every 5 minutes, pings /start on the DO directly.
  // Harmless no-op if already connected; recovers automatically if the
  // Gateway connection ever silently dies without a clean close.
  async scheduled(_event, env, ctx) {
    const id = env.GUARDIAN.idFromName("guardian-singleton");
    const stub = env.GUARDIAN.get(id);
    ctx.waitUntil(
      stub.fetch("https://internal/start", {
        headers: { "X-Guardian-Key": env.DISCORD_BOT_TOKEN }
      }).catch((err) => {
        console.error("[guardian] scheduled /start ping failed:", err);
      })
    );
  }
};

var LOCKDOWN_CHANNEL_TYPES = [0, 5];
var LOCKDOWN_DENY_PERMISSIONS = {
  SEND_MESSAGES: 1n << 11n,
  CREATE_INSTANT_INVITE: 1n << 0n
};
var LOCKDOWN_DENY_MASK =
  LOCKDOWN_DENY_PERMISSIONS.SEND_MESSAGES | LOCKDOWN_DENY_PERMISSIONS.CREATE_INSTANT_INVITE;

var RAID_WINDOW_MS = 60_000;
var RAID_SCORE_THRESHOLD = 10;
var RAID_JOIN_COUNT_THRESHOLD = 8;
var AVATAR_HASH_SHARE_THRESHOLD = 3;

var NUKE_WINDOW_MS = 30_000;
var NUKE_DELETE_THRESHOLD = 3;
var NUKE_BAN_KICK_THRESHOLD = 5;
var NUKE_CREATE_THRESHOLD = 5;
var NUKE_ROLE_GRANT_THRESHOLD = 5;
var NUKE_WEBHOOK_THRESHOLD = 1;
var NUKE_BOT_ADD_THRESHOLD = 1;

var AUDIT_ACTION = {
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
  WEBHOOK_CREATE: 50
};

var DANGEROUS_PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_WEBHOOKS: 1n << 29n
};

// Heuristics used to auto-provision a guild on GUILD_CREATE.
var STEWARD_ROLE_NAME_PATTERNS = [/steward/i, /moderator|mod\b/i];
var ALERTS_CHANNEL_NAME_PATTERNS = [/guardian/i, /mod-?log/i, /audit/i, /security/i, /alert/i];
var AUTO_CREATED_ALERTS_CHANNEL_NAME = "guardian-alerts";

var GuildGuardian = class {
  state;
  env;
  ws = null;
  heartbeatInterval = null;
  sequence = null;
  sessionId = null;
  resumeGatewayUrl = null;
  heartbeatAckReceived = true;
  consecutiveAuthFailures = 0;

  // Per-guild config, loaded from Supabase at startup and refreshed on
  // every GUILD_CREATE. Map<guildId, GuildConfig>
  guildConfigs = new Map();
  configsLoaded = false;

  // Per-guild scoring windows. Short-lived by design — losing these on a
  // DO restart/eviction is an acceptable tradeoff vs. persisting a rolling
  // window to storage.
  raidScoresByGuild = new Map(); // Map<guildId, RaidScoreEntry[]>
  nukeActionsByGuildAndActor = new Map(); // Map<guildId, Map<actorId, entry[]>>

  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    await this.ensureConfigsLoaded();
    const url = new URL(req.url);

    if (url.pathname === "/start") {
      if (!this.ws || this.ws.readyState !== WebSocket.READY_STATE_OPEN) {
        await this.connectGateway();
        return new Response("Gateway connection starting.", { status: 200 });
      }
      return new Response("Already connected.", { status: 200 });
    }

    if (url.pathname === "/guilds") {
      return Response.json({
        guilds: [...this.guildConfigs.entries()].map(([guildId, cfg]) => ({ guildId, ...cfg }))
      });
    }

    if (url.pathname === "/status") {
      const token = this.env.DISCORD_BOT_TOKEN ?? "";
      return Response.json({
        connected: this.ws?.readyState === WebSocket.READY_STATE_OPEN,
        sessionId: this.sessionId,
        sequence: this.sequence,
        guildsProvisioned: this.guildConfigs.size,
        consecutiveAuthFailures: this.consecutiveAuthFailures,
        tokenDiagnostic: {
          length: token.length,
          startsWithBotPrefix: token.startsWith("Bot "),
          hasLeadingOrTrailingWhitespace: token !== token.trim(),
          preview: token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : "(too short to preview)"
        }
      });
    }

    if (url.pathname === "/lockdown") {
      return this.handleManualLockdown(req);
    }
    if (url.pathname === "/endlockdown") {
      return this.handleManualEndLockdown(req);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── Config loading / provisioning ──────────────────────────────────────

  async ensureConfigsLoaded() {
    if (this.configsLoaded) return;
    try {
      const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/guardian_guild_config?select=*`, {
        headers: {
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Accept-Profile": "pitboss"
        }
      });
      if (res.ok) {
        const rows = await res.json();
        for (const row of rows) {
          this.guildConfigs.set(row.guild_id, {
            guildName: row.guild_name,
            ownerDiscordId: row.owner_discord_id,
            whitelistedActorIds: row.whitelisted_actor_ids ?? [],
            stewardRoleId: row.steward_role_id,
            alertsChannelId: row.alerts_channel_id
          });
        }
      } else {
        console.error("[guardian] failed to load guild configs:", res.status, await res.text());
      }
    } catch (err) {
      console.error("[guardian] error loading guild configs:", err);
    }
    this.configsLoaded = true;
  }

  // Called on GUILD_CREATE. Idempotent — safe to re-run on every reconnect;
  // re-derives config each time so role/channel renames stay in sync.
  async provisionGuild(guild) {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    const roles = guild.roles ?? [];
    const channels = guild.channels ?? [];
    const members = guild.members ?? [];

    const ownerDiscordId = guild.owner_id;

    // Steward role: first name-pattern match, preferring earlier patterns.
    // (Moved above the whitelist derivation below, since stewards are now
    // whitelisted too — this is used for both.)
    let stewardRoleId = null;
    for (const pattern of STEWARD_ROLE_NAME_PATTERNS) {
      const match = roles.find((r) => pattern.test(r.name) && r.name !== "@everyone");
      if (match) {
        stewardRoleId = match.id;
        break;
      }
    }

    // Whitelist: owner + anyone holding a role with ADMINISTRATOR + anyone
    // holding the steward role. Stewards routinely ban/kick raiders and
    // revoke invites as part of normal moderation — without this, an
    // actively-defending steward can trip nuke detection on themselves
    // (e.g. NUKE_BAN_KICK_THRESHOLD) and get auto-banned mid-incident.
    const adminRoleIds = new Set(
      roles.filter((r) => (BigInt(r.permissions) & DANGEROUS_PERMISSIONS.ADMINISTRATOR) !== 0n).map((r) => r.id)
    );
    const whitelistedActorIds = new Set([ownerDiscordId]);
    for (const member of members) {
      const hasAdminRole = member.roles?.some((rid) => adminRoleIds.has(rid));
      const hasStewardRole = stewardRoleId && member.roles?.includes(stewardRoleId);
      if (hasAdminRole || hasStewardRole) {
        whitelistedActorIds.add(member.user.id);
      }
    }

    // Alerts channel: find existing match, else auto-create a private one.
    let alertsChannelId = null;
    const textChannels = channels.filter((c) => c.type === 0);
    const existingAlertsChannel = textChannels.find((c) =>
      ALERTS_CHANNEL_NAME_PATTERNS.some((p) => p.test(c.name))
    );

    if (existingAlertsChannel) {
      alertsChannelId = existingAlertsChannel.id;
    } else {
      const permissionOverwrites = [
        { id: guild.id, type: 0, allow: "0", deny: (1n << 10n).toString() } // deny VIEW_CHANNEL for @everyone
      ];
      for (const roleId of adminRoleIds) {
        permissionOverwrites.push({ id: roleId, type: 0, allow: (1n << 10n).toString(), deny: "0" });
      }
      const createRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        method: "POST",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: AUTO_CREATED_ALERTS_CHANNEL_NAME,
          type: 0,
          topic: "Auto-created by pitboss-guardian for raid/nuke alerts.",
          permission_overwrites: permissionOverwrites
        })
      });
      if (createRes.ok) {
        const created = await createRes.json();
        alertsChannelId = created.id;
      } else {
        console.error(
          `[guardian] failed to auto-create alerts channel for guild ${guild.id}:`,
          createRes.status,
          await createRes.text()
        );
      }
    }

    const config = {
      guildName: guild.name,
      ownerDiscordId,
      whitelistedActorIds: [...whitelistedActorIds],
      stewardRoleId,
      alertsChannelId
    };
    this.guildConfigs.set(guild.id, config);

    await fetch(`${this.env.SUPABASE_URL}/rest/v1/guardian_guild_config`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "pitboss",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        guild_id: guild.id,
        guild_name: config.guildName,
        owner_discord_id: config.ownerDiscordId,
        whitelisted_actor_ids: config.whitelistedActorIds,
        steward_role_id: config.stewardRoleId,
        alerts_channel_id: config.alertsChannelId,
        alerts_channel_auto_created: !existingAlertsChannel,
        updated_at: new Date().toISOString()
      })
    }).catch((err) => console.error("[guardian] failed to persist guild config:", err));

    console.log(
      `[guardian] provisioned guild ${guild.id} (${guild.name}) — steward role: ${stewardRoleId ?? "none found"}, alerts channel: ${alertsChannelId ?? "FAILED"}`
    );
  }

  // ─── Manual lockdown / endlockdown (now guild-scoped) ───────────────────

  async handleManualLockdown(req) {
    let body = {};
    try {
      body = await req.json();
    } catch {}
    const guildId = body.guildId;
    if (!guildId) {
      return Response.json({ ok: false, error: "guildId is required in the request body." }, { status: 400 });
    }
    return this.lockdownGuild(guildId, { reason: body.reason ?? null, triggeredBy: body.triggeredBy ?? null });
  }

  // Shared lockdown implementation used by both the manual /lockdown route
  // and the automated delete-spam nuke response below. Returns a
  // Response so the manual route can pass results straight through.
  async lockdownGuild(guildId, meta = {}) {
    const lockdownKey = `manual_lockdown_state:${guildId}`;
    const existing = await this.state.storage.get(lockdownKey);
    if (existing?.active) {
      return Response.json({ ok: false, error: "Lockdown already active for this guild." }, { status: 409 });
    }

    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    const channelBackups = [];
    const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!channelsRes.ok) {
      return Response.json({ ok: false, error: `Failed to list channels (${channelsRes.status})` }, { status: 502 });
    }
    const channels = await channelsRes.json();
    const textChannels = channels.filter((c) => LOCKDOWN_CHANNEL_TYPES.includes(c.type));

    for (const channel of textChannels) {
      const existingOverwrite = (channel.permission_overwrites ?? []).find(
        (ow) => ow.id === guildId && ow.type === 0
      );
      channelBackups.push({
        channelId: channel.id,
        hadOverwrite: Boolean(existingOverwrite),
        priorAllow: existingOverwrite?.allow ?? "0",
        priorDeny: existingOverwrite?.deny ?? "0"
      });
      const priorAllow = BigInt(existingOverwrite?.allow ?? "0");
      const priorDeny = BigInt(existingOverwrite?.deny ?? "0");
      const newAllow = priorAllow & ~LOCKDOWN_DENY_MASK;
      const newDeny = priorDeny | LOCKDOWN_DENY_MASK;
      const putRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/permissions/${guildId}`, {
        method: "PUT",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: 0, allow: newAllow.toString(), deny: newDeny.toString() })
      });
      if (!putRes.ok) {
        console.error(`[guardian] lockdown overwrite failed for channel ${channel.id}:`, putRes.status, await putRes.text());
      }
    }

    let invitesDeleted = 0;
    const invitesRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/invites`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (invitesRes.ok) {
      const invites = await invitesRes.json();
      const results = await Promise.allSettled(
        invites.map((inv) =>
          fetch(`https://discord.com/api/v10/invites/${inv.code}`, {
            method: "DELETE",
            headers: { Authorization: `Bot ${token}` }
          })
        )
      );
      invitesDeleted = results.filter((r) => r.status === "fulfilled").length;
    }

    await this.state.storage.put(lockdownKey, {
      active: true,
      reason: meta.reason ?? null,
      triggeredBy: meta.triggeredBy ?? null,
      startedAt: Date.now(),
      channelBackups
    });

    return Response.json({ ok: true, channelsLocked: textChannels.length, invitesDeleted });
  }

  async handleManualEndLockdown(req) {
    let body = {};
    try {
      body = await req.json();
    } catch {}
    const guildId = body.guildId;
    if (!guildId) {
      return Response.json({ ok: false, error: "guildId is required in the request body." }, { status: 400 });
    }

    const lockdownKey = `manual_lockdown_state:${guildId}`;
    const existing = await this.state.storage.get(lockdownKey);
    if (!existing?.active) {
      return Response.json({ ok: false, error: "No active lockdown for this guild." }, { status: 409 });
    }

    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    let restored = 0;
    let failed = 0;
    for (const backup of existing.channelBackups) {
      if (backup.hadOverwrite) {
        const putRes = await fetch(`https://discord.com/api/v10/channels/${backup.channelId}/permissions/${guildId}`, {
          method: "PUT",
          headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: 0, allow: backup.priorAllow, deny: backup.priorDeny })
        });
        if (putRes.ok) restored++;
        else {
          failed++;
          console.error(`[guardian] endlockdown restore failed for channel ${backup.channelId}:`, putRes.status, await putRes.text());
        }
      } else {
        const delRes = await fetch(`https://discord.com/api/v10/channels/${backup.channelId}/permissions/${guildId}`, {
          method: "DELETE",
          headers: { Authorization: `Bot ${token}` }
        });
        if (delRes.ok) restored++;
        else {
          failed++;
          console.error(`[guardian] endlockdown overwrite-delete failed for channel ${backup.channelId}:`, delRes.status, await delRes.text());
        }
      }
    }

    await this.state.storage.delete(lockdownKey);
    return Response.json({
      ok: true,
      channelsRestored: restored,
      channelsFailed: failed,
      note: "Deleted invites from lockdown were not restored — recreate manually if needed."
    });
  }

  // ─── Gateway connection ──────────────────────────────────────────────────

  async connectGateway(resumeUrl) {
    const rawUrl = resumeUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    const gatewayUrl = rawUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    const res = await fetch(gatewayUrl, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) {
      console.error("[guardian] Gateway upgrade failed — no webSocket on response");
      await this.scheduleReconnect(5000);
      return;
    }
    ws.accept();
    this.ws = ws;
    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("close", (event) => this.handleClose(event));
    ws.addEventListener("error", (event) => console.error("[guardian] WebSocket error:", event));
  }

  async handleMessage(event) {
    const payload = JSON.parse(event.data);
    const { op, d, s, t } = payload;
    if (s !== null && s !== undefined) this.sequence = s;

    switch (op) {
      case 10:
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.resumeGatewayUrl) this.sendResume();
        else this.sendIdentify();
        break;
      case 11:
        this.heartbeatAckReceived = true;
        break;
      case 1:
        this.heartbeatAckReceived = false;
        this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
        break;
      case 0:
        await this.handleDispatch(t, d);
        break;
      case 7:
        this.ws?.close(4000, "reconnect requested");
        break;
      case 9:
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));
        this.sendIdentify();
        break;
    }
  }

  sendIdentify() {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.env.DISCORD_BOT_TOKEN?.trim(),
          // GUILDS is required for GUILD_CREATE to include populated roles/
          // channels/members — without it, provisionGuild() never had real
          // data to work with (no steward role, no alerts channel, no
          // whitelist). This was the root cause of provisioning silently
          // no-op'ing since intents were introduced.
          intents: (1 << 0) | (1 << 1) | (1 << 2), // GUILDS, GUILD_MEMBERS, GUILD_MODERATION
          properties: { os: "cloudflare-workers", browser: "pitboss-guardian", device: "pitboss-guardian" }
        }
      })
    );
  }

  sendResume() {
    this.ws?.send(
      JSON.stringify({
        op: 6,
        d: { token: this.env.DISCORD_BOT_TOKEN?.trim(), session_id: this.sessionId, seq: this.sequence }
      })
    );
  }

  startHeartbeat(intervalMs) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatAckReceived = true;
    this.heartbeatInterval = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        console.error("[guardian] Heartbeat ACK missed — reconnecting");
        this.ws?.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAckReceived = false;
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
    }, intervalMs);
  }

  async handleClose(event) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    console.error("[guardian] Gateway closed:", event.code, event.reason);
    const noResumeCodes = [4004, 4010, 4011, 4012, 4013, 4014];
    if (noResumeCodes.includes(event.code)) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
    }
    if (event.code === 4004) {
      this.consecutiveAuthFailures++;
      const backoffMs = Math.min(5 * 60_000, 5000 * 2 ** this.consecutiveAuthFailures);
      console.error(`[guardian] Auth failure #${this.consecutiveAuthFailures} — backing off ${backoffMs}ms`);
      await this.scheduleReconnect(backoffMs);
      return;
    }
    this.consecutiveAuthFailures = 0;
    await this.scheduleReconnect(2000 + Math.random() * 3000);
  }

  async scheduleReconnect(delayMs) {
    await new Promise((r) => setTimeout(r, delayMs));
    await this.connectGateway(this.resumeGatewayUrl ?? undefined);
  }

  // ─── Dispatch handling ────────────────────────────────────────────────────

  async handleDispatch(type, data) {
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
      case "GUILD_CREATE":
        await this.provisionGuild(data);
        break;
      case "GUILD_MEMBER_ADD":
        if (this.guildConfigs.has(data.guild_id)) await this.scoreJoin(data.guild_id, data);
        break;
      case "GUILD_AUDIT_LOG_ENTRY_CREATE":
        if (this.guildConfigs.has(data.guild_id)) await this.scoreAuditEntry(data.guild_id, data);
        break;
    }
  }

  // ─── Raid scoring (per guild) ───────────────────────────────────────────

  async scoreJoin(guildId, member) {
    const now = Date.now();
    const user = member.user;
    const createdAt = snowflakeToTimestamp(user.id);
    const accountAgeMs = now - createdAt;
    let score = 0;

    if (accountAgeMs < 24 * 60 * 60 * 1000) score += 3;
    else if (accountAgeMs < 7 * 24 * 60 * 60 * 1000) score += 2;
    if (!user.avatar) score += 1;
    if (/\d{4,}$/.test(user.username)) score += 1;

    if (!this.raidScoresByGuild.has(guildId)) this.raidScoresByGuild.set(guildId, []);
    const raidScores = this.raidScoresByGuild.get(guildId);
    raidScores.push({ timestamp: now, score, discordUserId: user.id, avatarHash: user.avatar ?? null });

    const pruned = raidScores.filter((e) => now - e.timestamp <= RAID_WINDOW_MS);
    this.raidScoresByGuild.set(guildId, pruned);

    const windowTotal = pruned.reduce((sum, e) => sum + e.score, 0);
    const rawJoinCount = pruned.length;
    const avatarHashCounts = new Map();
    for (const e of pruned) {
      if (!e.avatarHash) continue;
      avatarHashCounts.set(e.avatarHash, (avatarHashCounts.get(e.avatarHash) ?? 0) + 1);
    }
    const sharedAvatarHash = [...avatarHashCounts.entries()].find(([, count]) => count >= AVATAR_HASH_SHARE_THRESHOLD);

    if (windowTotal >= RAID_SCORE_THRESHOLD || rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD || sharedAvatarHash) {
      const reasons = [];
      if (windowTotal >= RAID_SCORE_THRESHOLD) reasons.push(`raid score ${windowTotal} reached in ${RAID_WINDOW_MS / 1000}s window`);
      if (rawJoinCount >= RAID_JOIN_COUNT_THRESHOLD) reasons.push(`${rawJoinCount} raw joins in ${RAID_WINDOW_MS / 1000}s window`);
      if (sharedAvatarHash) reasons.push(`${sharedAvatarHash[1]} joiners sharing avatar hash ${sharedAvatarHash[0].slice(0, 8)}...`);

      const sharedHashValue = sharedAvatarHash?.[0];
      const actorIds = pruned.filter((e) => e.score > 0 || (sharedHashValue && e.avatarHash === sharedHashValue)).map((e) => e.discordUserId);

      await this.respondToThreat(guildId, "raid", { reason: reasons.join("; "), score: windowTotal, actorIds, detail: { joins: pruned } });
      this.raidScoresByGuild.set(guildId, []);
    }
  }

  // ─── Nuke scoring (per guild) ───────────────────────────────────────────

  async scoreAuditEntry(guildId, entry) {
    const config = this.guildConfigs.get(guildId);
    if (!config) return;

    if (
      (entry.action_type === AUDIT_ACTION.MEMBER_KICK || entry.action_type === AUDIT_ACTION.MEMBER_BAN_ADD) &&
      entry.target_id === this.env.DISCORD_APP_ID &&
      entry.user_id !== config.ownerDiscordId
    ) {
      await this.respondToThreat(guildId, "nuke", {
        reason: `Unauthorized attempt to remove PitBoss from the guild by <@${entry.user_id}> — only the owner may do this`,
        actorIds: [entry.user_id],
        detail: { entry }
      });
      return;
    }

    if (entry.user_id === this.env.DISCORD_APP_ID) return;
    if (config.whitelistedActorIds.includes(entry.user_id)) return;

    const now = Date.now();
    const actorId = entry.user_id;
    const actionType = entry.action_type;

    if (actionType === AUDIT_ACTION.WEBHOOK_CREATE) {
      const reason = `Webhook created by non-whitelisted actor (threshold: ${NUKE_WEBHOOK_THRESHOLD})`;
      await this.respondToThreat(guildId, "nuke", { reason, actorIds: [actorId], detail: { entry } });
      await this.recordBannedId(guildId, actorId, "webhook_create", reason);
      return;
    }
    if (actionType === AUDIT_ACTION.BOT_ADD) {
      const reason = `Bot/integration added by non-whitelisted actor (threshold: ${NUKE_BOT_ADD_THRESHOLD})`;
      await this.respondToThreat(guildId, "nuke", { reason, actorIds: [actorId], detail: { entry } });
      await this.recordBannedId(guildId, actorId, "bot_add", reason);
      return;
    }
    if (actionType === AUDIT_ACTION.GUILD_UPDATE) {
      const dangerous = this.guildUpdateIsDangerous(entry);
      if (dangerous) {
        await this.respondToThreat(guildId, "nuke", { reason: dangerous, actorIds: [actorId], detail: { entry } });
        return;
      }
    }
    if (actionType === AUDIT_ACTION.ROLE_UPDATE) {
      const grantedDangerous = this.roleUpdateGrantsDangerousPermission(entry);
      if (grantedDangerous) {
        await this.respondToThreat(guildId, "nuke", { reason: `Dangerous permission grant: ${grantedDangerous.join(", ")}`, actorIds: [actorId], detail: { entry } });
        return;
      }
    }

    const trackedTypes = [
      AUDIT_ACTION.CHANNEL_DELETE, AUDIT_ACTION.ROLE_DELETE, AUDIT_ACTION.MEMBER_BAN_ADD,
      AUDIT_ACTION.MEMBER_KICK, AUDIT_ACTION.CHANNEL_CREATE, AUDIT_ACTION.ROLE_CREATE, AUDIT_ACTION.MEMBER_ROLE_UPDATE
    ];
    if (trackedTypes.includes(actionType)) {
      if (!this.nukeActionsByGuildAndActor.has(guildId)) this.nukeActionsByGuildAndActor.set(guildId, new Map());
      const guildActorMap = this.nukeActionsByGuildAndActor.get(guildId);

      const existing = guildActorMap.get(actorId) ?? [];
      existing.push({ timestamp: now, actionType });
      const pruned = existing.filter((e) => now - e.timestamp <= NUKE_WINDOW_MS);
      guildActorMap.set(actorId, pruned);

      const deleteCount = pruned.filter((e) => e.actionType === AUDIT_ACTION.CHANNEL_DELETE || e.actionType === AUDIT_ACTION.ROLE_DELETE).length;
      const banKickCount = pruned.filter((e) => e.actionType === AUDIT_ACTION.MEMBER_BAN_ADD || e.actionType === AUDIT_ACTION.MEMBER_KICK).length;
      const createCount = pruned.filter((e) => e.actionType === AUDIT_ACTION.CHANNEL_CREATE || e.actionType === AUDIT_ACTION.ROLE_CREATE).length;
      const roleGrantCount = pruned.filter((e) => e.actionType === AUDIT_ACTION.MEMBER_ROLE_UPDATE).length;

      const fire = async (reason, score, isDeleteSpam = false) => {
        await this.respondToThreat(guildId, "nuke", { reason, score, actorIds: [actorId], detail: { entries: pruned }, isDeleteSpam });
        guildActorMap.delete(actorId);
      };

      if (deleteCount >= NUKE_DELETE_THRESHOLD) await fire(`${deleteCount} channel/role deletions by one actor in ${NUKE_WINDOW_MS / 1000}s`, deleteCount, true);
      else if (banKickCount >= NUKE_BAN_KICK_THRESHOLD) await fire(`${banKickCount} bans/kicks by one actor in ${NUKE_WINDOW_MS / 1000}s`, banKickCount);
      else if (createCount >= NUKE_CREATE_THRESHOLD) await fire(`${createCount} channel/role creations by one actor in ${NUKE_WINDOW_MS / 1000}s (spam)`, createCount);
      else if (roleGrantCount >= NUKE_ROLE_GRANT_THRESHOLD) await fire(`${roleGrantCount} role grants to members by one actor in ${NUKE_WINDOW_MS / 1000}s`, roleGrantCount);
    }
  }

  guildUpdateIsDangerous(entry) {
    const changes = entry.changes ?? [];
    const verificationChange = changes.find((c) => c.key === "verification_level");
    if (verificationChange && typeof verificationChange.new_value === "number" && typeof verificationChange.old_value === "number" && verificationChange.new_value < verificationChange.old_value) {
      return `Verification level lowered (${verificationChange.old_value} → ${verificationChange.new_value})`;
    }
    const ownerChange = changes.find((c) => c.key === "owner_id");
    if (ownerChange) return `Server ownership transferred to <@${ownerChange.new_value}>`;
    return null;
  }

  roleUpdateGrantsDangerousPermission(entry) {
    const permsChange = entry.changes?.find((c) => c.key === "permissions");
    if (!permsChange || !permsChange.new_value) return null;
    const newPerms = BigInt(permsChange.new_value);
    const oldPerms = BigInt(permsChange.old_value ?? "0");
    const granted = [];
    for (const [name, bit] of Object.entries(DANGEROUS_PERMISSIONS)) {
      const hasNow = (newPerms & bit) !== 0n;
      const hadBefore = (oldPerms & bit) !== 0n;
      if (hasNow && !hadBefore) granted.push(name);
    }
    return granted.length > 0 ? granted : null;
  }

  // ─── Response: every action fires together, scoped to the guild ────────

  async respondToThreat(guildId, type, ctx) {
    console.log(`[guardian] THREAT DETECTED in ${guildId} (${type}):`, ctx.reason);
    const results = await Promise.allSettled([
      this.autoPunish(guildId, ctx.actorIds),
      this.autoLockdown(guildId, type, ctx),
      this.alertSteward(guildId, type, ctx),
      this.logEvent(guildId, type, ctx)
    ]);
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const labels = ["autoPunish", "autoLockdown", "alertSteward", "logEvent"];
        console.error(`[guardian] ${labels[i]} failed:`, result.reason);
      }
    }
  }

  async autoPunish(guildId, actorIds) {
    for (const userId of actorIds) await this.banWithRetry(guildId, userId);
  }

  async banWithRetry(guildId, userId, attempt = 0) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/bans/${userId}`, {
      method: "PUT",
      headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ delete_message_seconds: 3600 })
    });
    if (res.ok) return;
    if (res.status === 429 && attempt < 2) {
      let retryAfterMs = 1000;
      try {
        const body = await res.clone().json();
        if (typeof body.retry_after === "number") retryAfterMs = Math.ceil(body.retry_after * 1000);
      } catch {
        const headerVal = res.headers.get("Retry-After");
        if (headerVal) retryAfterMs = Math.ceil(parseFloat(headerVal) * 1000);
      }
      console.error(`[guardian] ban rate-limited for ${userId}, retrying in ${retryAfterMs}ms`);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return this.banWithRetry(guildId, userId, attempt + 1);
    }
    console.error(`[guardian] ban failed for ${userId}:`, res.status, await res.text());
  }

  async autoLockdown(guildId, type, ctx) {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();

    // Raids, and now delete-spam nukes, get the full guild-wide lockdown:
    // verification bump + invite revocation + channel send/invite lock.
    // Delete-spam is the most damaging nuke pattern and has no undo for
    // already-deleted channels/roles, so the priority is stopping any
    // other compromised session from doing more damage.
    if (type === "raid" || ctx.isDeleteSpam) {
      await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        method: "PATCH",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ verification_level: 4 }) // VERY_HIGH
      });
      const invitesRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/invites`, {
        headers: { Authorization: `Bot ${token}` }
      });
      if (invitesRes.ok) {
        const invites = await invitesRes.json();
        await Promise.all(
          invites.map((inv) => fetch(`https://discord.com/api/v10/invites/${inv.code}`, { method: "DELETE", headers: { Authorization: `Bot ${token}` } }))
        );
      }
      await this.lockdownGuild(guildId, {
        reason: `auto-lockdown: ${type}${ctx.isDeleteSpam ? " (delete-spam)" : ""} — ${ctx.reason}`,
        triggeredBy: "pitboss-guardian:auto"
      }).catch((err) => console.error("[guardian] auto channel lockdown failed:", err));
    }

    if (type === "nuke") {
      const entries = ctx.detail?.entries ?? [ctx.detail?.entry];
      for (const entry of entries) {
        if (entry?.action_type === AUDIT_ACTION.ROLE_UPDATE && entry.target_id) {
          const permsChange = entry.changes?.find((c) => c.key === "permissions");
          if (permsChange?.old_value !== undefined) {
            await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles/${entry.target_id}`, {
              method: "PATCH",
              headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ permissions: permsChange.old_value })
            });
          }
        }
      }
    }
  }

  async alertSteward(guildId, type, ctx) {
    const config = this.guildConfigs.get(guildId);
    const emoji = type === "raid" ? "🚨" : "💣";
    const rolePrefix = config?.stewardRoleId ? `<@&${config.stewardRoleId}> ` : "";
    const lockdownApplied = type === "raid" || ctx.isDeleteSpam;
    const lines = [
      `${emoji} ${rolePrefix}**${type.toUpperCase()} DETECTED**`,
      ctx.reason,
      ctx.actorIds.length > 0 ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}` : null,
      lockdownApplied ? `Auto-lockdown applied. Full detail logged.` : `Full detail logged.`
    ].filter(Boolean);

    if (!config?.alertsChannelId) {
      console.error(`[guardian] no alerts channel configured for guild ${guildId} — falling back to DM`);
      await this.dmBackupContacts(guildId, type, ctx, lines.join("\n"));
      return;
    }

    const res = await fetch(`https://discord.com/api/v10/channels/${config.alertsChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN?.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n") })
    });
    if (!res.ok) {
      console.error("[guardian] alert channel post failed:", res.status, await res.text());
      await this.dmBackupContacts(guildId, type, ctx, lines.join("\n"));
    }
  }

  async dmBackupContacts(guildId, type, ctx, preformattedContent) {
    const config = this.guildConfigs.get(guildId);
    const recipients = config?.whitelistedActorIds ?? [];
    if (recipients.length === 0) return;
    const content =
      preformattedContent ??
      [
        `**${type.toUpperCase()} DETECTED** (backup alert — primary alert channel unreachable)`,
        ctx.reason,
        ctx.actorIds.length > 0 ? `Accounts banned: ${ctx.actorIds.map((id) => `<@${id}>`).join(", ")}` : null
      ].filter(Boolean).join("\n");
    await Promise.all(recipients.map((discordId) => this.sendBackupDirectMessage(discordId, content)));
  }

  async sendBackupDirectMessage(discordUserId, content) {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: discordUserId })
    });
    if (!dmRes.ok) {
      console.error("[guardian] backup DM channel open failed:", dmRes.status, await dmRes.text());
      return;
    }
    const dmChannel = await dmRes.json();
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!msgRes.ok) console.error("[guardian] backup DM send failed:", msgRes.status, await msgRes.text());
  }

  async logEvent(guildId, type, ctx) {
    await fetch(`${this.env.SUPABASE_URL}/rest/v1/security_events`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "pitboss",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        guild_id: guildId,
        event_type: type,
        trigger_reason: ctx.reason,
        actor_discord_id: ctx.actorIds[0] ?? null,
        score: ctx.score ?? null,
        action_taken: (type === "raid" || ctx.isDeleteSpam) ? "ban+lockdown+alert" : "ban+alert",
        detail: { actorIds: ctx.actorIds, ...ctx.detail }
      })
    });
  }

  async recordBannedId(guildId, discordId, triggerType, reason) {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/guardian_banned_ids`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "pitboss",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ discord_id: discordId, guild_id: guildId, trigger_type: triggerType, reason })
    });
    if (!res.ok) console.error("[guardian] recordBannedId failed:", res.status, await res.text());
  }
};

var DISCORD_EPOCH = 1420070400000n;
function snowflakeToTimestamp(snowflake) {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
}

export { GuildGuardian, src_default as default };
