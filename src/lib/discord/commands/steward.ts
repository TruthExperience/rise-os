registerCommand("steward_analyse", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const supabase = createAdminClient();

  const { data: fullIncident, error: fetchErr } = await supabase
    .schema("pitboss")
    .from("incidents")
    .select("incident_type, description, season, round, lap, league_id")
    .eq("id", incident.id)
    .single();

  if (fetchErr || !fullIncident) {
    return {
      content: "Couldn't load the incident details for analysis.",
      ephemeral: true,
    };
  }

  const llmRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/pitboss/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "steward",
      league: fullIncident.league_id,
      fetch_regulations: true,
      incident: {
        incident_type: fullIncident.incident_type,
        description: fullIncident.description,
        season: fullIncident.season,
        round: fullIncident.round,
        lap: fullIncident.lap,
        league_id: fullIncident.league_id,
      },
    }),
  });

  if (!llmRes.ok) {
    console.error("[steward_analyse] LLM call failed:", llmRes.status, await llmRes.text());
    return { content: "AI analysis failed — try again shortly.", ephemeral: true };
  }

  const ai = await llmRes.json();
  const suggestion = ai.suggestion ?? {};

  const { error: updateErr } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      ai_verdict: suggestion.verdict ?? ai.verdict,
      ai_penalty: suggestion.penalty ?? ai.penalty,
      ai_points: suggestion.points ?? ai.points ?? 0,
      ai_reasoning: suggestion.reasoning ?? ai.reasoning,
      ai_confidence: suggestion.confidence ?? ai.confidence ?? 0,
      ai_articles: suggestion.articles ?? ai.articles ?? [],
      ai_model: ai.model,
      ai_analysed_at: new Date().toISOString(),
    })
    .eq("id", incident.id);

  if (updateErr) {
    console.error("[steward_analyse] update failed:", updateErr);
    return {
      content: `AI analysis ran, but saving the result failed: ${updateErr.message}`,
      ephemeral: true,
    };
  }

  const verdict = suggestion.verdict ?? ai.verdict ?? "No verdict returned";
  const penalty = suggestion.penalty ?? ai.penalty ?? "None suggested";
  const points = suggestion.points ?? ai.points ?? 0;
  const confidence = suggestion.confidence ?? ai.confidence ?? 0;
  const reasoning = suggestion.reasoning ?? ai.reasoning ?? "No reasoning provided";
  const articles: string[] = suggestion.articles ?? ai.articles ?? [];

  const lines = [
    `**AI Steward Analysis**`,
    `Verdict: ${verdict}`,
    `Suggested penalty: ${penalty}${points ? ` (${points} pts)` : ""}`,
    `Confidence: ${Math.round(confidence * 100)}%`,
    articles.length ? `Articles: ${articles.join(", ")}` : null,
    `\n${reasoning}`,
    `\nUse \`/steward verdict\` to submit the final ruling.`,
  ].filter(Boolean);

  return { content: lines.join("\n"), ephemeral: false };
});

registerCommand("steward_verdict", async (ctx) => {
  const denied = await requireSteward(ctx);
  if (denied) return { content: denied, ephemeral: true };

  const incident = await findIncidentByChannel(ctx.leagueId, ctx.channelId);
  if (!incident) {
    return {
      content: "This channel isn't linked to an incident ticket.",
      ephemeral: true,
    };
  }

  const verdict = ctx.options.verdict as string;
  const penalty = ctx.options.penalty as string | undefined;
  const penaltyPoints = (ctx.options.points as number) ?? 0;
  const stewardNotes = ctx.options.notes as string | undefined;
  const overrideReason = ctx.options.override_reason as string | undefined;

  const resolverId = await getOrCreateDriverId(ctx.discordUserId);
  const supabase = createAdminClient();

  const { data: updated, error } = await supabase
    .schema("pitboss")
    .from("incidents")
    .update({
      verdict,
      penalty: penalty ?? null,
      penalty_points: penaltyPoints,
      steward_notes: stewardNotes ?? null,
      override_reason: overrideReason ?? null,
      status: "resolved",
      resolved_by: resolverId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", incident.id)
    .select()
    .single();

  if (error || !updated) {
    console.error("[steward_verdict] update failed:", error);
    return {
      content: `Couldn't save the verdict: ${error?.message ?? "unknown error"}`,
      ephemeral: true,
    };
  }

  if (penaltyPoints > 0 && updated.accused_driver_id) {
    const { error: ledgerError } = await supabase
      .schema("pitboss")
      .from("penalty_ledger")
      .insert({
        driver_id: updated.accused_driver_id,
        league_id: updated.league_id,
        incident_id: incident.id,
        points: penaltyPoints,
        reason: `${verdict} — ${penalty ?? "Penalty issued"}`,
      });

    if (ledgerError) {
      console.error("[steward_verdict] penalty_ledger insert failed:", ledgerError);
    }
  }

  await postTicketMessage(
    ctx.channelId,
    [
      `**Verdict:** ${verdict}`,
      penalty ? `**Penalty:** ${penalty}${penaltyPoints ? ` (${penaltyPoints} pts)` : ""}` : null,
      stewardNotes ? `**Notes:** ${stewardNotes}` : null,
      overrideReason ? `**Override reason:** ${overrideReason}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  return { content: "Verdict recorded and posted to the ticket.", ephemeral: false };
});
