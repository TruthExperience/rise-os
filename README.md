# Rise OS

Rise OS is a Next.js and Supabase platform that runs multiple sim racing leagues (including AARL, WSC, TRL, SRH and HRL) and college football dynasty leagues. It covers league and franchise pages, driver profiles, certification exams and licences, stewarding (incidents, appeals, penalties), results and standings, telemetry and car setups, and a Discord bot (PitBoss) that exposes much of the same data as slash commands.

Current version: **1.2.0-beta**

## Stack

| Piece | What it is |
| --- | --- |
| Web app | Next.js 14 (App Router), React 18, Tailwind CSS, installable PWA |
| Database and auth | Supabase (Postgres, Supabase Auth) |
| Hosting | Vercel for the web app |
| Workers | Two Cloudflare Workers: `pitboss-guardian` and `pitboss-proxy` |
| Discord | Interactions endpoint inside the Next.js app, plus the guardian Worker for gateway-level moderation |

Vercel and Cloudflare are separate deployment pipelines. A push to GitHub triggers both, but they build and fail independently.

## Repository layout

```
src/
  app/                  Pages and API routes (App Router)
    api/pitboss/        Racing APIs: incidents, appeals, steward, results, standings, licences, telemetry, fm setups, llm, ...
    api/franchises/     College football franchise APIs
    api/discord/        Interactions endpoint and command registration
    api/cron/           Scheduled jobs (see "Cron jobs")
    pitboss/            Racing UI
    franchise/, league/ League and franchise UI
  components/           Shared UI (BottomNav lives in components/ui)
  lib/
    session.ts          Server-side session (use this in API routes)
    supabase/           Supabase clients: server.ts (also getAuthedDriver), client, browser, admin
    compat/             next-auth/react compatibility shim backed by Supabase Auth
    discord/            Command router, command modules, permissions
    pitboss/            Racing domain logic (setup engine, telemetry, stewarding access, ...)
  middleware.ts         Session refresh and login redirect
pitboss-guardian/       Cloudflare Worker: anti-raid and anti-nuke
pitboss-proxy/          Cloudflare Worker: LLM proxy, ESPN relay, check-in countdown cron
vercel.json             Function durations and cron schedules
```

## Database

One Supabase project with three schemas:

- `public`: users and profile linkage (`users.auth_user_id`, `users.discord_id`).
- `pitboss`: racing data (drivers, contracts, licences, incidents, results, guardian config, ...).
- `rise_os`: college football data (franchises, players, ratings, ...).

Conventions every route follows:

- Name the schema explicitly on every client (`.schema('pitboss')` or `.schema('rise_os')`).
- Routes backed by Supabase data set `export const dynamic = 'force-dynamic'` and return `Cache-Control: no-store`.
- The service-role key is used only on the server. Never import a service-role client into a client component.

## Authentication

Sign-in is Supabase Auth only, either Discord OAuth or email and password (`/login`, callback at `/auth/callback`). NextAuth is no longer used.

- **Middleware** (`src/middleware.ts`) refreshes the session and redirects signed-out users to `/login`. Public paths: `/login`, `/auth`, `/api`, `/directory`, `/l/`, `/open-in-safari`. API routes do their own checks.
- **API routes** call `getSession()` from `src/lib/session.ts`. It returns `{ user }` with `id`, `userId`, `discordId`, `username`, `avatar`, or `null` when signed out. `discordId` is undefined for accounts with no Discord link.
- **Routes that need the driver record** use `getAuthedDriver()` from `src/lib/supabase/server.ts`. `src/lib/getSupabaseUserId.ts` re-exports it for older imports.
- **Client pages** still import `useSession`, `signIn` and `signOut` from `next-auth/react`. That specifier is aliased (in `next.config.js` for webpack and in `tsconfig.json` for types) to `src/lib/compat/next-auth-react.tsx`, which reads the Supabase session. The real `next-auth` package is not installed.
- **Server-to-server calls** inside the platform authenticate with the shared `PITBOSS_INTERNAL_KEY`, sent as an `X-PitBoss-Key` header.

## Discord bot (PitBoss)

Discord posts every slash command and component interaction to `/api/discord/interactions`, which verifies the signature and hands off to `src/lib/discord/commands/router.ts`.

To add a command:

1. Create or extend a module in `src/lib/discord/commands/` and call `registerCommand("name", handler)`.
2. Add a side-effect import for that module at the bottom of `router.ts`. If this is missed, the command silently does nothing.
3. Add the command definition to the list in `src/app/api/discord/register-commands/route.ts`.
4. Re-register with the Discord API by opening `/api/discord/register-commands?secret=<REGISTER_COMMANDS_SECRET>`.

## Workers

### pitboss-guardian

Multi-tenant anti-raid and anti-nuke worker. One Durable Object holds the single Discord Gateway connection for the whole bot and auto-provisions every guild's settings into `pitboss.guardian_guild_config`. A cron trigger pings `/start` every five minutes as a self-heal. Admin endpoints: `/start`, `/guilds`, `/status`, `/lockdown`, `/endlockdown`, `/reload-config`.

### pitboss-proxy

Endpoints: `/infer`, `/steward`, `/setup-feedback`, `/espn-relay` and `/health`. It fronts the LLM providers (OpenRouter, Groq, OpenAI, Anthropic) so slow model calls stay out of Vercel function limits, and a one-minute cron updates check-in countdown posts.

The Next.js app reaches it through `PITBOSS_WORKER_URL`. `/api/pitboss/llm` accepts either a signed-in session or `X-PitBoss-Key`.

Both Workers use Wrangler 4 and have a `build` script (`wrangler deploy --dry-run --outdir dist`) so Cloudflare's default `npm run build` step succeeds.

## Cron jobs

Schedules live in `vercel.json` and run in UTC. Each route checks `Authorization: Bearer $CRON_SECRET`.

| Route | Schedule |
| --- | --- |
| `/api/cron/ea-ratings-all` | Daily 06:00 |
| `/api/cron/hbcu-rosters` | Mondays 09:00 |
| `/api/cron/cfb-irl-records` | Mondays 10:00 |
| `/api/cron/racing-team-records` | Mondays 11:00 |

`/api/cron/ea-ratings` (single team) exists and is not scheduled.

## Environment variables

Names only. Set values in Vercel (web app) and with `wrangler secret put` (Workers).

**Web app (Vercel)**

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`
- Discord: `PITBOSS_DISCORD_BOT_TOKEN`, `PITBOSS_DISCORD_APPLICATION_ID`, `PITBOSS_DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `REGISTER_COMMANDS_SECRET`
- Platform: `PITBOSS_INTERNAL_KEY`, `PITBOSS_WORKER_URL`, `GUARDIAN_WORKER_URL`, `NEXT_PUBLIC_APP_URL`
- Jobs: `CRON_SECRET`, `PITBOSS_CHECKIN_REMINDER_CRON_SECRET`
- Other: `GROQ_API_KEY` (voice transcription), `GOOGLE_SHEETS_CLIENT_EMAIL`, `GOOGLE_SHEETS_PRIVATE_KEY`, `GOOGLE_SHEETS_EFRL_JURY_ID`
- Provided by Vercel: `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`

**pitboss-guardian secrets**: `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

**pitboss-proxy secrets**: `PITBOSS_INTERNAL_KEY`, `PITBOSS_DISCORD_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_KEY`, `ANTHROPIC_KEY`

## Running locally

```
npm install
npm run dev          # web app on http://localhost:3000
npm run build        # production build
npm run lint
```

Workers (run inside `pitboss-guardian/` or `pitboss-proxy/`):

```
npm install
npm run dev          # wrangler dev
npm run typecheck
npm run deploy       # wrangler deploy
```

## Things worth knowing

- Next.js 14 passes `params` to routes and pages as a plain object. Do not write them as promises until the framework upgrade.
- The PWA service worker never caches `/api/*`, league rules pages or driver profile pages (`NetworkOnly` rules in `next.config.js`). If a page looks stale, check there first.
- Track deep links for the FM setup tool work at `/pitboss/fm-setups/<track-slug>` or `/pitboss/fm-setups?track=<track-slug>`.
- The racing team roster is served by `/api/pitboss/franchises/<leagueId>/<franchiseId>/roster`; `/franchise/<leagueId>/<franchiseId>/roster` delegates to the same handler.
