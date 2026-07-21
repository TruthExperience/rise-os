import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "rise_os" } }
);

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { data, error } = await supabaseAdmin
    .from("leagues")
    .select("*")
    .eq("id", params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json();

  const { data, error } = await supabaseAdmin
    .from("leagues")
    .update(body)
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const ext = file.name.split(".").pop();
  const path = `${params.id}/logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const storageClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: uploadError } = await storageClient.storage
    .from("league-logos")
    .upload(path, buffer, { upsert: true, contentType: file.type });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: { publicUrl } } = storageClient.storage
    .from("league-logos")
    .getPublicUrl(path);

  const { data, error } = await supabaseAdmin
    .from("leagues")
    .update({ logo_url: publicUrl })
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // PitBoss keeps its own separate leagues table (it predates the merge
  // into Rise OS and serves a different domain — race governance vs.
  // dynasty/league management). If this league also has a matching
  // pitboss.leagues row, keep its logo_url in sync too. Otherwise
  // PitBoss-side pages (Standings, Results, etc.) silently keep showing
  // the old/broken logo after every future upload here, exactly like the
  // 7/20 incident where three leagues' pitboss.leagues rows were still
  // pointing at a non-existent logo.jpeg while rise_os.leagues was fine.
  const pitbossClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "pitboss" } }
  );
  await pitbossClient
    .from("leagues")
    .update({ logo_url: publicUrl })
    .eq("id", params.id);
  // Not failing the request if this errors or matches zero rows (e.g. a
  // CFB dynasty league with no PitBoss presence) — the rise_os update
  // above already succeeded and is the source of truth for that domain.

  return NextResponse.json(data);
}
