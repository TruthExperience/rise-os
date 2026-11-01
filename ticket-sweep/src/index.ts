export interface Env {
  SWEEP_URL: string;
  CRON_SECRET: string;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const res = await fetch(env.SWEEP_URL, {
            method: "GET",
            headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
          });
          if (!res.ok) {
            console.error("[ticket-sweep] failed", res.status, await res.text());
          }
        } catch (err) {
          console.error("[ticket-sweep] error:", err);
        }
      })()
    );
  },
} satisfies ExportedHandler<Env>;
