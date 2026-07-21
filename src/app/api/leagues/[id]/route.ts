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

  // PitBoss keeps its own separate leagues table (pre-dating the merge into
  // Rise OS). If this league also has a pitboss.leagues row, keep its
  // logo_url in sync too — otherwise PitBoss-side pages (Standings,
  // Results, etc.) silently keep showing the old/broken logo after every
  // future upload here, exactly like the 7/20 incident.
  const pitbossClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "pitboss" } }
  );
  await pitbossClient
    .from("leagues")
    .update({ logo_url: publicUrl })
    .eq("id", params.id);
  // Intentionally not failing the request if this errors/no-ops (e.g. no
  // matching pitboss row) — the rise_os update above already succeeded.

  return NextResponse.json(data);
}
