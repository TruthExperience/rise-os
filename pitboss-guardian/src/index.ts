// pitboss-guardian — multi-tenant anti-raid / anti-nuke worker
//
// CHANGE FROM PREVIOUS VERSION: no more hardcoded GUILD_ID / STEWARD_ROLE_ID /
// ALERTS_CHANNEL_ID / WHITELISTED_ACTOR_IDS constants. Every guild the bot is
// a member of gets auto-provisioned on GUILD_CREATE (fires on first join AND
// on every gateway reconnect for guilds already joined), and its config is
// persisted to pitboss.guardian_guild_config so it survives DO restarts.
//
// A single Durable Object instance holds the one Gateway connection for the
// whole bot — this is correct Discord architecture: one bot token gets one
// gateway session covering all its guilds, not one session per guild.
// Per-guild state (config, raid/nuke scoring windows) is kept in Maps keyed
// by guild_id inside that one instance.
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
//
// PATCH (2026-08-16): guild config was loaded from Supabase exactly once
// per Durable Object lifetime, guarded by a one-shot `configsLoaded`
// boolean that never got reset. Since this DO holds a single long-lived
// Gateway connection (by design — can run for days), any edit made
// directly to pitboss.guardian_guild_config (e.g. adding someone to
// whitelisted_actor_ids) was invisible to the running instance until it
// happened to restart. Concretely: a whitelisted actor could still get
// auto-banned for bot_add/nuke triggers minutes after being whitelisted,
// because scoreAuditEntry() was checking a stale in-memory copy.
// Fixed by:
//   1. Replacing the one-shot flag with a TTL (`configsLoadedAt` +
//      CONFIG_REFRESH_INTERVAL_MS) so config is periodically re-pulled
//      from Supabase instead of cached forever.
//   2. Calling ensureConfigsLoaded() at the top of scoreJoin() and
//      scoreAuditEntry() too, not just in the HTTP fetch() handler — the
//      cron's /start ping alone wasn't reaching the Gateway-event code
//      path where staleness actually mattered.
//   3. Adding a guarded /reload-config endpoint so whitelist edits can be
//      pushed instantly instead of waiting out the TTL.
//
// PATCH (2026-08-16, later same day): the fixes above were correct but
// never took effect in production, because this is a long-lived Durable
// Object holding an open Gateway WebSocket — Cloudflare doesn't hot-swap
// code into an already-running DO instance on redeploy; it only picks up
// new code the next time that instance's isolate actually restarts, which
// doesn't happen on any predictable timeline for a continuously-active
// object like this one. Confirmed in production: whitelisted actors kept
// getting auto-banned by scoreAuditEntry() well after the whitelist and
// the fixed script were both already correct — the running instance was
// still executing the pre-fix in-memory class, unaware anything had
// changed underneath it. One-time fix at the time: renamed the DO id seed
// to force a fresh isolate, then rotated DISCORD_BOT_TOKEN to invalidate
// the orphaned old instance's Gateway session.
//
// PATCH (2026-08-17): replaced the manual id-seed rename with a permanent
// mechanism so this class of bug can't recur and doesn't require touching
// the bot token on every deploy:
//   1. The DO's id is now derived from env.CF_VERSION_METADATA.id (bound
//      below), which changes on every deploy. Every push therefore gets
//      an automatically fresh Durable Object instance running whatever
//      code is live at that moment — no more manually bumping a suffix.
//   2. That alone would just leave the *previous* instance orphaned and
//      running forever instead of the crash-once bug from before, so each
//      instance now self-retires: on every successful READY/RESUMED, it
//      upserts its own version id into pitboss.guardian_active_version
//      (single row, id='singleton'). A watchdog timer, running on the
//      same cadence as the config TTL refresh, checks that row — if it
//      ever finds a different version id there (meaning a newer instance
//      has since become READY and overwritten it), this instance closes
//      its own Gateway connection and does not reconnect. No external
//      signal forces this; the old instance retires itself once it
//      notices it's obsolete.
//   Requires wrangler.jsonc / wrangler.toml to bind version metadata:
//     { "version_metadata": { "binding": "CF_VERSION_METADATA" } }
//   Trade-off: there's a short window (up to VERSION_WATCHDOG_INTERVAL_MS)
//   after a deploy where both the old and new instance are connected to
//   the Gateway on the same bot token, so a raid/nuke event landing in
//   that window could theoretically be double-processed (duplicate ban
//   attempts are harmless no-ops, duplicate alerts are the only visible
//   side effect). Given the alternative — an orphan that can run for
//   hours undetected — this is the right trade.
//   The watchdog fails open: if the Supabase check itself fails (network
//   blip, transient 5xx), the instance does NOT retire on that tick. Only
//   an explicit, successfully-read mismatch triggers retirement.
//
// PATCH (2026-09-23): retuned raid/nuke detection — the previous values
// were tripping on normal server activity, not just actual attacks:
//   1. WEBHOOK_CREATE and BOT_ADD were never actually threshold-gated
//      despite NUKE_WEBHOOK_THRESHOLD / NUKE_BOT_ADD_THRESHOLD existing as
//      constants — both action types fired an instant ban on the very
//      first occurrence, ignoring the threshold value entirely. A member
//      with Manage Webhooks setting up one legitimate integration, or a
//      member with Manage Server adding one ordinary bot, got auto-banned
//      on the spot. Folded both into the same per-actor windowed counter
//      already used for deletions/bans/creations/role-grants below, so
//      they now require threshold-or-more occurrences by the same actor
//      within NUKE_WINDOW_MS, same as every other tracked nuke pattern.
//   2. Raised RAID_JOIN_COUNT_THRESHOLD, RAID_SCORE_THRESHOLD,
//      AVATAR_HASH_SHARE_THRESHOLD, NUKE_DELETE_THRESHOLD,
//      NUKE_BAN_KICK_THRESHOLD, NUKE_CREATE_THRESHOLD, and
//      NUKE_ROLE_GRANT_THRESHOLD — the old values were tight enough that
//      ordinary bursts (a growth spurt, a round of event-channel setup, a
//      bulk end-of-season role grant) could plausibly cross them. New
//      values keep the same detection shape but need materially more
//      volume/velocity before firing.
//   3. Left the unauthorized-bot-removal check, GUILD_UPDATE (verification
//      level lowered, ownership transferred), and ROLE_UPDATE (dangerous
//      permission granted) as instant single-occurrence triggers —
//      unlike a webhook or a bot, there's no ordinary reason for a
//      non-whitelisted actor to do any of these even once, so
//      threshold-gating them would just slow down response to an
//      unambiguous attack.
//   Tune further by adjusting the constants directly below if your
//   servers' normal activity still trips these — they're plain numbers,
//   nothing else needs to change to raise or lower them again.
//
// PATCH (2026-09-25): fetch() had no top-level try/catch. Any uncaught
// exception in the routing block or in handleManualLockdown/
// handleManualEndLockdown (e.g. Discord returning non-JSON on a transient
// outage, a malformed permission_overwrite value, or a CPU/wall-clock
// limit hit while a Gateway-triggered response was mid-flight for the
// same guild) bubbled out as a bare framework 500 with no body. On the
// Next.js side, moderation.ts's guardianCall() does
// `data?.error ?? "pitboss-guardian error (${status})"` — with a null
// body that fallback is all a steward ever saw, with no way to tell what
// actually broke. Wrapping the whole method means any thrown error is now
// caught, logged, and returned as { ok: false, error: <message> } at 500,
// so that fallback picks up the real reason instead. Doesn't fix whatever
// throws; makes the next occurrence self-diagnosing.

// PATCH (2026-10-09): provisionGuild()'s save to guardian_guild_config and
// logEvent()'s insert into security_events ignored non-2xx responses, so a
// rejected write (wrong/missing service-role key, RLS, missing column)
// was completely silent — the Guardian ran from in-memory config while the
// database never got the guild's row. Both now log status + body on
// failure, and /status reports lastPersist (guild, ok, status, body, time).
//
// PATCH (2026-10-14): added GUILD_MEMBER_REMOVE handling. When a member
// leaves, is kicked, or is banned (Discord fires GUILD_MEMBER_REMOVE for all
// three), their pitboss.driver_leagues row for that server's league is
// deleted immediately, so the app and bot stop treating them as a member.
//   - The pitboss.drivers row and all history are kept.
//   - Owners, co-owners and commissioners are never deleted.
//   - Circuit breaker: if more than MEMBER_REMOVAL_MAX_PER_WINDOW members
//     are removed from one guild within MEMBER_
