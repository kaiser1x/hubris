// Phase D — sandbox dependency-install orchestration (brief Phase 5).
//
// Installation policy (conservative by design):
// - Lifecycle scripts NEVER run: every install carries --ignore-scripts.
//   (brief Phase 5: start with ignore-scripts; per-repo opt-in lands later,
//   and only ever inside the sandbox.)
// - Lockfiles are honored for reproducibility: pnpm --frozen-lockfile,
//   npm ci. No `install` that can silently resolve new versions.
// - Nothing runs on the HUBRIS host: the clone is never executed locally,
//   and install runs only in the disposable sandbox.
// - Manager is detected from root lockfiles when the caller omits it;
//   an explicit manager always wins. pnpm-lock.yaml wins ties (HUBRIS is a
//   pnpm workspace; its demos are pnpm-first).
// - Network egress to the registry is required and expected inside the
//   sandbox (VM-isolated, disposable). No host credentials travel: the
//   spawn payload carries no `env` at all.

import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";

export type PackageManager = "pnpm" | "npm";

export function detectManager(tracked: string[]): PackageManager | null {
  const roots = new Set(
    tracked.filter((p) => !p.includes("/"))
  );
  if (roots.has("pnpm-lock.yaml")) return "pnpm";
  if (roots.has("package-lock.json")) return "npm";
  return null;
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  // node:20-slim ships npm + corepack but not pnpm itself; bootstrap it
  // from the registry (sandbox network) when missing.
  pnpm: "command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10 --no-audit --no-fund; pnpm install --frozen-lockfile --ignore-scripts",
  npm: "npm ci --ignore-scripts --no-audit --no-fund",
};

// Installs run longer than probes: 300s execution + 330s poll budget by
// default, env-overridable. Output stays under the shared execution limits.
export interface InstallTiming {
  timeoutS: number;
  waitMs: number;
}

export const DEFAULT_INSTALL_TIMING: InstallTiming = {
  timeoutS: 300,
  waitMs: 330000,
};

export function installTimingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): InstallTiming {
  const timeout = Number(env.HUBRIS_INSTALL_TIMEOUT);
  const wait = Number(env.HUBRIS_INSTALL_WAIT_MS);
  return {
    timeoutS:
      Number.isFinite(timeout) && timeout > 0
        ? Math.floor(timeout)
        : DEFAULT_INSTALL_TIMING.timeoutS,
    waitMs:
      Number.isFinite(wait) && wait > 0
        ? Math.floor(wait)
        : DEFAULT_INSTALL_TIMING.waitMs,
  };
}

// Extract the checkout tarball, drop secret-adjacent names (same denylist
// as checkout), then install. Bounded tail marker keeps evidence small.
export function buildInstallScript(
  manager: PackageManager,
  excluded: string[]
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `${INSTALL_COMMANDS[manager]}; echo INSTALL_DONE`
  );
}
