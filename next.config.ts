import type { NextConfig } from "next";

// `output: "standalone"` is needed for self-hosted deployment (Docker, VPS).
// On Vercel, the platform handles the build output — standalone mode is
// harmless (Vercel ignores it) but produces extra files. We enable it
// unconditionally so the same build works everywhere.
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Better-sqlite3 is a native module — Vercel's serverless functions need
  // it as an optional dependency (it's only used in local dev; Turso is used
  // in production). Mark it as external so Next.js doesn't try to bundle it.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
