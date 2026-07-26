import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Client-side Supabase client using the publishable/anon key — only ever
// used for direct-to-storage uploads from the browser (e.g. incident
// evidence clips). Never use this for data access that should go through
// createAdminClient() on the server.
//
// Lazily instantiated: creating this eagerly at module scope caused
// `next build` to crash while statically prerendering pages that import
// this file, since Next executes an SSR pass during build for pages
// even when they're 'use client' — and NEXT_PUBLIC_* env vars aren't
// guaranteed to be populated in that specific prerender context.
let _client: SupabaseClient | null = null

export function getSupabaseBrowser(): SupabaseClient {
  if (_client) return _client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error(
      'Supabase browser client requested before NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY were available. ' +
      'This should only be called client-side, in response to user action.'
    )
  }

  _client = createClient(url, key)
  return _client
}
