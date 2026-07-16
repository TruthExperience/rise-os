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
        // Never cache API routes — this data changes on every upload and
        // was being served stale by the default NetworkFirst rule for
        // /api/* once the network was slow or timed out.
        urlPattern: /^https?:\/\/[^/]+\/api\/.*/i,
        handler: "NetworkOnly",
      },
      {
        // Never cache the league rules/document pages themselves. With
        // cacheOnFrontEndNav + aggressiveFrontEndNavCaching enabled, the
        // page shell and RSC payload for routes like
        // /league/[id]/rules can be served from the service worker's
        // cache on in-app navigation even when the underlying data has
        // changed (e.g. right after a document upload). A normal browser
        // "clear cache" does not reliably clear this — it lives in
        // Cache Storage, not the HTTP cache. Forcing NetworkOnly here
        // ensures every visit to a rules page re-fetches the live page.
        urlPattern: /^https?:\/\/[^/]+\/league\/[^/]+\/rules.*/i,
        handler: "NetworkOnly",
      },
      {
        // Same issue as the rules pages above, now hitting the driver
        // profile page: its tabs (Career, Stats, etc.) are populated by
        // client-side data that changes frequently, but
        // aggressiveFrontEndNavCaching was serving a stale page
        // shell/RSC payload on in-app navigation to
        // /pitboss/drivers/[id], so newly added tabs and content updates
        // didn't show up even after a fresh deploy. Force NetworkOnly so
        // every visit re-fetches the live page.
        urlPattern: /^https?:\/\/[^/]+\/pitboss\/drivers\/.*/i,
        handler: "NetworkOnly",
      },
      {
        // Same issue again on /pitboss/setups: car class/track pickers and
        // the generated recommendation are populated client-side per
        // request, and with cacheOnFrontEndNav + aggressiveFrontEndNavCaching
        // the service worker could otherwise replay a stale page
        // shell/RSC payload on in-app navigation instead of hitting the
        // options endpoint and recommend/feedback routes fresh. Force
        // NetworkOnly so every visit re-fetches the live page.
        urlPattern: /^https?:\/\/[^/]+\/pitboss\/setups.*/i,
        handler: "NetworkOnly",
      },
    ],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = withPWA(nextConfig);
