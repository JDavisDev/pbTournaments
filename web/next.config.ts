import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Local mode's database (Postgres compiled to WebAssembly) loads its own files at runtime.
  serverExternalPackages: ['@electric-sql/pglite', 'web-push'],
  partialPrefetching: true,
  async headers() {
    return [
      // The service worker (public/sw.js) must never be served stale.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }] },
      // Other sites can't frame the app (a hidden Refund or Delete button under
      // a click), except the TV board, which a venue may put on its own page.
      {
        source: '/((?!tv/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
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
