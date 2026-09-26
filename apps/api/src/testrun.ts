// Phase E — real repository test execution (first milestone only).
//
// Scope: run a repo's OWN test command in an installed sandbox workspace
// and report exit-0 PASS / non-zero-or-timeout FAIL. No autonomous bug
// hunting, no regression generation, no scoring system — those land later.
//
// Test-command policy:
// - Resolution order: explicit caller `testCommand` (future agent use) wins;
//   otherwise read package.json `scripts.test` from the LOCAL clone.
// - The manager invokes it (`pnpm test` / `npm test`) so node_modules/.bin
//   is on PATH. pre/post hooks therefore run — inside the disposable
//   sandbox only, never on the host. Install stays --ignore-scripts locked.
// - If no test script exists, the endpoint refuses (400) instead of
//   inventing a command. No fake runs.
// - Phase attribution without scoring: the script prints TEST_BEGIN after a
//   successful install, so absence of the marker means the INSTALL phase
//   failed and presence means the TEST phase ran. PASS/FAIL is still just
//   exit code + timeout.

import * as fs from "fs";
import * as path from "path";
import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";

// Test runs combine install + tests: 600s execution + 660s poll budget by
// default, env-overridable. Output stays under the shared execution limits.
export interface TestTiming {
  timeoutS: number;
  waitMs: number;
}

export const DEFAULT_TEST_TIMING: TestTiming = {
  timeoutS: 600,
  waitMs: 660000,
};

export function testTimingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TestTiming {
  const timeout = Number(env.HUBRIS_TEST_TIMEOUT);
  const wait = Number(env.HUBRIS_TEST_WAIT_MS);
  return {
    timeoutS:
      Number.isFinite(timeout) && timeout > 0
        ? Math.floor(timeout)
        : DEFAULT_TEST_TIMING.timeoutS,
    waitMs:
      Number.isFinite(wait) && wait > 0
        ? Math.floor(wait)
        : DEFAULT_TEST_TIMING.waitMs,
  };
}

// Parse the test command out of a package.json document. Returns the raw
// scripts.test string, or null when absent/unparseable. Never throws.
export function parseTestCommand(pkgText: string): string | null {
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
    const test = pkg?.scripts?.["test"];
    return typeof test === "string" && test.trim().length > 0 ? test.trim() : null;
  } catch {
    return null;
  }
}

// Read scripts.test from a local clone checkout. Null when the file is
// missing or declares no test script. Never throws.
export async function readPackageTestScript(src: string): Promise<string | null> {
  let pkgText: string | null = null;
  try {
    pkgText = await fs.promises.readFile(path.join(src, "package.json"), "utf-8");
  } catch {
    return null;
  }
  return parseTestCommand(pkgText);
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const TEST_BEGIN_MARKER = "TEST_BEGIN";

// Extract, install, then run the test invocation (default `<manager> test`
// so node_modules/.bin is on PATH). The marker separates the install phase
// (absent) from the test phase (present) in captured stdout.
export function buildTestScript(
  manager: PackageManager,
  excluded: string[],
  invoke?: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  const run = invoke ?? `${manager} test`;
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `${INSTALL_COMMANDS[manager]}; echo ${TEST_BEGIN_MARKER}; ${run}`
  );
}
