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
