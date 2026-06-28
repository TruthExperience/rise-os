const runtimeCaching = require("@ducanh2912/next-pwa/cache");

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
        // was being served stale by the library's default NetworkFirst
        // rule for /api/* once the network was slow or timed out.
        urlPattern: /^https?:\/\/[^/]+\/api\/.*/i,
        handler: "NetworkOnly",
      },
      ...runtimeCaching,
    ],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = withPWA(nextConfig);
