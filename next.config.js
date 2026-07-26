const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  swcMinify: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      {
        urlPattern: /^https?:\/\/[^/]+\/api\/.*/i,
        handler: "NetworkOnly",
      },
      {
        urlPattern: /^https?:\/\/[^/]+\/league\/[^/]+\/rules.*/i,
        handler: "NetworkOnly",
      },
      {
        urlPattern: /^https?:\/\/[^/]+\/pitboss\/drivers\/.*/i,
        handler: "NetworkOnly",
      },
      {
        urlPattern: /^https?:\/\/[^/]+\/pitboss\/setups.*/i,
        handler: "NetworkOnly",
      },
      {
        urlPattern: /^https?:\/\/[^/]+\/franchises\/.*/i,
        handler: "NetworkOnly",
      },
      {
        urlPattern: /^https?:\/\/[^/]+\/league\/[^/]+$/i,
        handler: "NetworkOnly",
      },
    ],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Required for steward_analyse's deferred-response flow in
    // src/lib/discord/commands/router.ts — after() is still experimental
    // on Next 14.2.3 (stable in Next 15). Lets the LLM call/DB write for
    // /steward analyse keep running past the initial Discord ACK.
    after: true,
  },
};

module.exports = withPWA(nextConfig);
