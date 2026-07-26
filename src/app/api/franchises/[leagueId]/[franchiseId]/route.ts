import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// Lazy singleton — constructed on first use inside a handler, not at
// module load. Avoids "supabaseUrl is required" during Next.js's
// build-time page-data collection.
let _supabaseAdmin: SupabaseClient | null = null;
function getSupabaseAdmin(): SupabaseClient {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: "rise_os" } }
    );
  }
  return _supabaseAdmin;
}

export async function GET(_req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  const supabaseAdmin = getSupabaseAdmin();

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .select("*")
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  const supabaseAdmin = getSupabaseAdmin();
  const body = await req.json();

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .update(body)
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { leagueId: string; franchiseId: string } }) {
  const supabaseAdmin = getSupabaseAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size > MAX_LOGO_BYTES) {
    return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  const ext = file.name.split(".").pop();
  const path = `${params.franchiseId}/logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Separate client for storage — no schema restriction needed here since
  // this only touches the storage API, not postgrest tables. Already
  // constructed inside the handler, so this one was never part of the bug.
  const storageClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error: uploadError } = await storageClient.storage
    .from("franchise-logos")
    .upload(path, buffer, { upsert: true, contentType: file.type });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: { publicUrl } } = storageClient.storage
    .from("franchise-logos")
    .getPublicUrl(path);

  const { data, error } = await supabaseAdmin
    .from("franchises")
    .update({ logo_url: publicUrl })
    .eq("id", params.franchiseId)
    .eq("league_id", params.leagueId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}
