import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

// Cookie-based client for use in Server Components and Route Handlers
// that need RLS to respect the logged-in user's session.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from a Server Component — cookies can't be set.
            // Middleware handles session refresh so this is safe to ignore.
          }
        },
      },
    }
  )
}

// Service-role admin client — bypasses RLS.
// Never expose this to the browser. Use only in trusted server contexts.
//
// The `global.fetch` override below forces every request this client makes
// to skip Next.js's Data Cache (cache: 'no-store'). Without it, a route
// handler that forgets `export const dynamic = 'force-dynamic'` can end up
// serving a frozen response indefinitely — this data changes via direct
// SQL/migrations, never via a revalidation path, so there's no downside to
// always bypassing the cache here.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (url, options = {}) =>
          fetch(url, { ...options, cache: 'no-store' }),
      },
    }
  )
}
