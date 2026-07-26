import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only client. Uses the service role key so it can call the
// SECURITY DEFINER join_league() functions, which are granted to
// `service_role` (rise-os doesn't use Supabase Auth, so there's no
// per-request user JWT to rely on — auth is handled by NextAuth instead).
//
// NEVER import this file into a "use client" component.
//
// Lazy singleton — the real client isn't constructed until something
// actually touches a property on `supabaseServer` (e.g.
// `supabaseServer.from(...)`). This avoids "supabaseUrl is required"
// crashes during Next.js's build-time page-data collection on platforms
// (Cloudflare Pages) that don't guarantee env vars are injected at
// import time.

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
  }
  return _client;
}

export const supabaseServer = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
