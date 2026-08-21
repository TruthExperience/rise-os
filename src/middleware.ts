import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// getClaims() is a network call to Supabase auth with no built-in timeout.
// Vercel middleware has a hard ~25-30s execution ceiling — if Supabase auth
// stalls, an unbounded call here gets killed by the platform instead of
// failing fast on its own terms. Bound it explicitly and treat a timeout
// the same as "no session" (redirect to login) rather than hanging the
// whole request.
const AUTH_CHECK_TIMEOUT_MS = 5000

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  let user: any = null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS)
    // getClaims() doesn't take an AbortSignal directly, so race it against
    // the timeout instead — this bounds worst-case latency without needing
    // the client to support cancellation.
    const { data } = await Promise.race([
      supabase.auth.getClaims(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('auth check timed out'))
        )
      }),
    ])
    clearTimeout(timeout)
    user = data?.claims ?? null
  } catch (err) {
    // Auth check failed or timed out — fail closed (treat as logged out)
    // rather than letting the request hang toward the platform's own
    // middleware timeout. Logged so a spike in these is visible separately
    // from genuine unauthenticated traffic.
    console.error('[middleware] auth check failed:', err)
    user = null
  }

  if (
    !user &&
    !request.nextUrl.pathname.startsWith('/login') &&
    !request.nextUrl.pathname.startsWith('/auth') &&
    !request.nextUrl.pathname.startsWith('/api')
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // /api is excluded here (not just skipped in the redirect check above):
    // API routes each do their own auth via getAuthedDriver(), so running
    // this middleware's Supabase auth call again on top is redundant work
    // and, per the timeout risk above, redundant risk — doubly true for
    // routes polled frequently (e.g. live telemetry polling every few
    // seconds).
    '/((?!_next/static|_next/image|favicon.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
