import type { NextConfig } from "next";
import path from "path";

// Monorepo root (HUBRIS). Pins workspace resolution so Next.js stops
// walking up to the stray pnpm-workspace.yaml in C:\Users\Q, which sits
// outside this git repository.
const repoRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  // Dev-only origin allowlist. Browsing the dev server from a non-localhost
  // address (LAN device, WSL virtual-NIC IP, …) requires an entry here or
  // Next blocks dev requests (RSC payloads, HMR socket) for that origin and
  // pages stall. localhost is always allowed and remains the stable URL.
  allowedDevOrigins: ["192.168.1.253", "172.27.176.1"],
  turbopack: {
    root: repoRoot,
  },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
