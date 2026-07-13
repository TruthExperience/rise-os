import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pitboss" } }
);

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discordId = (session.user as any).discordId;
  if (!discordId) {
    return NextResponse.json({ error: "Missing discordId on session" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("drivers")
    .select()
    .eq("discord_id", discordId)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discordId = (session.user as any).discordId;
  if (!discordId) {
    return NextResponse.json({ error: "Missing discordId on session" }, { status: 401 });
  }

  const username = (session.user as any).username ?? session.user.email;
  const avatar = (session.user as any).avatar ?? null;

  const { data, error } = await supabaseAdmin
    .from("drivers")
    .upsert(
      {
        discord_id: discordId,
        discord_username: username,
        discord_avatar: avatar,
      },
      { onConflict: "discord_id", ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const discordId = (session.user as any).discordId;
  if (!discordId) {
    return NextResponse.json({ error: "Missing discordId on session" }, { status: 401 });
  }

  const body = await req.json();
  const { display_name } = body;

  const { data, error } = await supabaseAdmin
    .from("drivers")
    .update({ display_name, updated_at: new Date().toISOString() })
    .eq("discord_id", discordId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
