import { AuthOptions } from "next-auth";
import DiscordProvider from "next-auth/providers/discord";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const authOptions: AuthOptions = {
  providers: [
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const p = profile as any;
        token.discordId = p.id;
        token.username = p.username;
        token.avatar = p.avatar;
        token.discriminator = p.discriminator;

        await supabaseAdmin.from("users").upsert(
          {
            discord_id: p.id,
            username: p.username,
            avatar: p.avatar,
            email: p.email,
          },
          { onConflict: "discord_id" }
        );
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).discordId = token.discordId;
        (session.user as any).username = token.username;
        (session.user as any).avatar = token.avatar;
        (session.user as any).discriminator = token.discriminator;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};
