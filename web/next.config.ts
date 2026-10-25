import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Local mode's database (Postgres compiled to WebAssembly) loads its own files at runtime.
  serverExternalPackages: ['@electric-sql/pglite'],
  partialPrefetching: true,
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
