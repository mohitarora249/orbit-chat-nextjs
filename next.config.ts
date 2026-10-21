import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The custom server in server.ts hosts Next.js and Socket.IO on the same HTTP server.
  poweredByHeader: false,
  // Lets a second dev server run from the same checkout without sharing build output.
  distDir: process.env.NEXT_DIST_DIR || ".next"
};

export default nextConfig;
