import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

interface RuleSearchRow {
  article_id: string;
  article_number: string | null;
  chapter: string | null;
  title: string;
  snippet: string | null;
  bot_summary: string | null;
  rank: number;
}

// No permission check here on purpose — rulebook lookup is open to
// anyone in the league, same posture as roster_view.
registerCommand("kb_search", async (ctx) => {
  const query = ctx.options.query as string;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("pitboss")
    .rpc("search_rule_articles", {
      p_league_id: ctx.leagueId,
      p_query: query,
      p_limit: 3,
    });

  if (error) {
    console.error("[kb_search] search_rule_articles failed:", error);
    return {
      content: `Couldn't search the rulebook right now: ${error.message}`,
      ephemeral: true,
    };
  }

  const rows = data as RuleSearchRow[] | null;
  if (!rows || rows.length === 0) {
    return {
      content: `No rule articles matched "${query}".`,
      ephemeral: true,
    };
  }

  const lines = rows.map((row) => {
    const label = row.article_number
      ? `**${row.article_number}${row.chapter ? ` — ${row.chapter}` : ""}: ${row.title}**`
      : `**${row.title}**`;
    const body = row.bot_summary ?? row.snippet ?? "";
    return `${label}\n${body}`;
  });

  return {
    content: lines.join("\n\n"),
    ephemeral: false,
  };
});
