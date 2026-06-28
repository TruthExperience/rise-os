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

        const supabaseAdmin = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // upsert AND select back the row so we get the Supabase UUID
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

        if (error) {
          console.error('Failed to upsert/fetch user:', error)
        } else {
          token.id = data.id // <-- the Supabase UUID, not the Discord ID
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id            = token.id as string // <-- was token.sub!
        session.user.discordId     = token.discordId
        session.user.username      = token.username
        session.user.avatar        = token.avatar
        session.user.discriminator = token.discriminator
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
