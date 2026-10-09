import { createClient, createAdminClient, getVerifiedDiscordId } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Only allow same-site relative paths. `${origin}${next}` with next="@evil.com"
  // or "//evil.com" would otherwise redirect off-site.
  const rawNext = searchParams.get('next') ?? '/'
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\') ? rawNext : '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  const supabase = await createClient()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`)
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    const admin = createAdminClient()
    const meta = user.user_metadata ?? {}
    // Discord id comes from a verified Discord identity only. user_metadata
    // is user-editable, so an email account could otherwise put any member's
    // Discord id there and have this upsert re-point that member's
    // public.users row (auth_user_id) at the attacker's login.
    // Email/password accounts have no Discord identity, so this is null.
    const discordId: string | null = getVerifiedDiscordId(user)
    const username: string | null = meta.full_name ?? meta.name ?? null
    const avatar: string | null = meta.avatar_url ?? null

    if (discordId) {
      // Link to (or create) the row this Discord ID has always used,
      // the same way the old NextAuth jwt callback did — but now also
      // stamping auth_user_id so server-side Supabase auth checks can
      // resolve this session to the right public.users row.
      const { error: upsertError } = await admin
        .from('users')
        .upsert(
          {
            discord_id: discordId,
            username,
            avatar,
            email: user.email,
            auth_user_id: user.id,
          },
          { onConflict: 'discord_id' }
        )

      if (upsertError) {
        console.error('Failed to link discord user on callback:', upsertError)
      }
    } else {
      // Email/password account — no discord_id to match on, so only
      // link/create by auth_user_id itself.
      const { error: upsertError } = await admin
        .from('users')
        .upsert(
          {
            auth_user_id: user.id,
            email: user.email,
            username: username ?? user.email,
          },
          { onConflict: 'auth_user_id' }
        )

      if (upsertError) {
        console.error('Failed to link email user on callback:', upsertError)
      }
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}
