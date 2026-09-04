registerCommand("cap_board", async (ctx) => {
  const supabase = createAdminClient();
  const divisionFilter = ctx.options.division as string | undefined;
  const seasonFilter = ctx.options.season as string | undefined; // "25" | "26"

  let walletQuery = supabase
    .schema("pitboss")
    .from("franchise_wallets")
    .select("franchise_id, division")
    .eq("league_id", ctx.leagueId);

  if (seasonFilter) {
    // Exact match against the season choice, e.g. "26" -> "F1_26".
    walletQuery = walletQuery.eq("division", `F1_${seasonFilter}`);
  } else if (divisionFilter) {
    walletQuery = walletQuery.ilike("division", `%${divisionFilter}%`);
  }

  const { data: wallets, error } = await walletQuery;

  if (error) {
    console.error("[cap_board] wallet query failed:", error);
    return { content: `Couldn't load cap board: ${error.message}`, ephemeral: true };
  }

  if (!wallets || wallets.length === 0) {
    return {
      content: seasonFilter
        ? `No franchises found for season "${seasonFilter}" in this league.`
        : divisionFilter
        ? `No franchises found for division matching "${divisionFilter}" in this league.`
        : "No franchise wallets found for this league.",
      ephemeral: true,
    };
  }

  const { data: franchises } = await supabase
    .schema("rise_os")
    .from("franchises")
    .select("id, name")
    .in(
      "id",
      wallets.map((w) => w.franchise_id)
    );

  const nameById = new Map((franchises ?? []).map((f) => [f.id, f.name]));

  const summaries = await Promise.all(
    wallets.map((w) =>
      buildCapSummary(supabase, ctx.leagueId, w.franchise_id, nameById.get(w.franchise_id) ?? w.franchise_id)
    )
  );

  // Teams closest to (or over) their cap first — most actionable view for
  // a steward or commissioner checking compliance.
  summaries.sort((a, b) => (a.computedRemaining ?? Infinity) - (b.computedRemaining ?? Infinity));

  const lines = summaries.map((s) => {
    const flag = s.balanceDrift ? " ⚠️" : "";
    const freeze = s.capFreezeActive ? " 🧊" : "";
    return `**${s.franchiseName}** — ${fmtMoney(s.computedSpend)} / ${fmtMoney(s.startingWallet)} (${fmtMoney(s.computedRemaining)} left, ${s.driverCount} contracts)${freeze}${flag}`;
  });

  const header = seasonFilter
    ? `**Salary Cap Board — F1_${seasonFilter}**`
    : divisionFilter
    ? `**Salary Cap Board — ${divisionFilter}**`
    : `**Salary Cap Board**`;

  return { content: [header, ...lines].join("\n"), ephemeral: false };
});
