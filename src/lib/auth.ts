import { NextAuthOptions } from 'next-auth'
import DiscordProvider from 'next-auth/providers/discord'
import { createClient } from '@supabase/supabase-js'

export const authOptions: NextAuthOptions = {
  providers: [
    DiscordProvider({
      clientId:     process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const p = profile as any

        token.discordId     = p.id
        token.username      = p.username
        token.avatar        = p.avatar ?? null
        token.discriminator = p.discriminator

        // TEMP DEBUG — confirm env vars are present without printing secrets
        console.log('[auth debug] SUPABASE_URL set:', !!process.env.NEXT_PUBLIC_SUPABASE_URL)
        console.log('[auth debug] SERVICE_ROLE_KEY set:', !!process.env.SUPABASE_SERVICE_ROLE_KEY)
        console.log('[auth debug] SERVICE_ROLE_KEY length:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length)

        const supabaseAdmin = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { data, error } = await supabaseAdmin
          .from('users')
          .upsert(
            {
              discord_id: p.id,
              username:   p.username,
              avatar:     p.avatar,
              email:      p.email,
            },
            { onConflict: 'discord_id' }
          )
          .select('id')
          .single()

        // TEMP DEBUG — full visibility into what the upsert actually returned
        console.log('[auth debug] upsert data:', JSON.stringify(data))
        console.log('[auth debug] upsert error:', JSON.stringify(error))

        if (error) {
          console.error('Failed to upsert/fetch user:', error)
        } else {
          token.id = data.id
          console.log('[auth debug] token.id set to:', token.id)
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id            = token.id as string
        session.user.discordId     = token.discordId
        session.user.username      = token.username
        session.user.avatar        = token.avatar
        session.user.discriminator = token.discriminator

        // TEMP DEBUG
        console.log('[auth debug] session.user.id set to:', session.user.id)
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
