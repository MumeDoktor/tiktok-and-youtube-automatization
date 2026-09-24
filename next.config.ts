import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `npm run verify` sets this so a build never clobbers a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // better-sqlite3 is a native module - it must stay external to the bundler.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
