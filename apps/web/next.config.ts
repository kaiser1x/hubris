import type { NextConfig } from "next";
import path from "path";

// Monorepo root (HUBRIS). Pins workspace resolution so Next.js stops
// walking up to the stray pnpm-workspace.yaml in C:\Users\Q, which sits
// outside this git repository.
const repoRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.253"],
  turbopack: {
    root: repoRoot,
  },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
