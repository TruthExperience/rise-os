import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy singleton — the real client isn't constructed until something
// actually touches a property on `supabase` (e.g. `supabase.from(...)`).
// This avoids "supabaseUrl is required" crashes during Next.js's build-time
// page-data collection on platforms (Cloudflare Pages) that don't guarantee
// env vars are injected at import time.

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    _client = createClient(supabaseUrl, supabaseAnonKey);
  }
  return _client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
