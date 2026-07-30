import { registerCommand } from "./registry";
import { createAdminClient } from "@/lib/supabase/server";

function resolveAppBaseUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) {
    const withScheme = /^https?:\/\//.test(explicit)
      ? explicit
      : `https://${explicit}`;
    return withScheme.replace(/\/$/, "");
  }

  const prodUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prodUrl) return `https://${prodUrl}`;

  const deploymentUrl = process.env.VERCEL_URL;
  if (deploymentUrl) return `https://${deploymentUrl}`;

  return null;
}

registerCommand("exam", async (ctx) => {
  const appBaseUrl = resolveAppBaseUrl();
  if (!appBaseUrl) {
    return {
      content: "Exam page link is unavailable right now — the app URL isn't configured on this deployment.",
      ephemeral: true,
    };
  }

  const examUrl = `${appBaseUrl}/pitboss/cert`;

  return {
    content: `📝 See available exams and take yours here: ${examUrl}`,
    ephemeral: true,
  };
});

registerCommand("cert", async (ctx) => {
  const supabase = createAdminClient();

  const { data: driver } = await supabase
    .schema("pitboss")
    .from("drivers")
    .select("id")
    .eq("discord_id", ctx.discordUserId)
    .maybeSingle();

  if (!driver) {
    return {
      content: "No driver profile found for your account yet — take an exam with `/exam` to get started.",
      ephemeral: true,
    };
  }

  const { data: licences, error } = await supabase
    .schema("pitboss")
    .from("licences")
    .select("role_code, status, issued_at")
    .eq("driver_id", driver.id)
    .eq("league_id", ctx.leagueId)
    .eq("status", "active")
    .order("issued_at", { ascending: false });

  if (error) {
    console.error("[cert] licences query failed:", error);
    return { content: "Couldn't load your certifications — try again shortly.", ephemeral: true };
  }

  if (!licences || licences.length === 0) {
    return {
      content: "No active certifications for this league yet. Use `/exam` to take one.",
      ephemeral: true,
    };
  }

  const lines = licences.map((l) => {
    const date = l.issued_at ? new Date(l.issued_at).toLocaleDateString() : "unknown date";
    return `✅ **${l.role_code}** — passed ${date}`;
  });

  return {
    content: `**Your certifications:**\n${lines.join("\n")}`,
    ephemeral: true,
  };
});
