import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Local mode's database (Postgres compiled to WebAssembly) loads its own files at runtime.
  serverExternalPackages: ['@electric-sql/pglite', 'web-push'],
  partialPrefetching: true,
  async headers() {
    // The service worker (public/sw.js) must never be served stale.
    return [{ source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }] }];
  },
  async redirects() {
    // Registrations are part of the Players page now.
    return [{ source: '/t/:id/registrations', destination: '/t/:id/players', permanent: false }];
  },
  turbopack: {
    // The repo root has its own package.json (DB tests, simulator); the app lives here.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
