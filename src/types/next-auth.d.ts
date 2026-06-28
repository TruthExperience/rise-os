import NextAuth, { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      discordId: string
      username: string
      avatar: string | null
      discriminator: string
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    discordId: string
    username: string
    avatar: string | null
    discriminator: string
  }
}
