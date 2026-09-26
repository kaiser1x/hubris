// Phase G — patch application (mechanism milestone only).
//
// Applies a caller-provided unified diff inside a disposable sandbox
// workspace, then installs and runs the suite. This is the application
// MECHANISM: parsing Forge output and choosing patches autonomously is the
// later loop (with the verification state machine), not this endpoint.
//
// Application policy:
// - The diff travels as an upload mapped OUTSIDE the workspace, then
//   `git apply` runs after extraction (node images lack git, so it is
//   apt-installed from the registry inside the sandbox first).
// - `git apply` (default -p1) validates hunks for real; a bad patch fails
//   the run with phase 'patch', never silently.
// - Phase markers separate patch (PATCH_OK) from install from test
//   (TEST_BEGIN) in captured stdout. PASS/FAIL stays exit-code-only.
// - The real repository is never touched: everything happens to the
//   extracted tarball copy in the disposable VM.

import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";
import { TEST_BEGIN_MARKER } from "./testrun";

// Fixed staging slot outside the workspace (survives the workspace reset).
export const DIFF_STAGING_PATH = "/tmp/hubris-upload/patch.diff";

export const PATCH_OK_MARKER = "PATCH_OK";

// Light plausibility gate so obvious non-diffs fail fast with a 400.
// `git apply` in the sandbox is the real validator.
export function isPlausibleDiff(diff: string): boolean {
  if (diff.length < 10 || diff.length > 20000) return false;
  if (!diff.includes("@@")) return false;
  return (
    diff.includes("diff --git") ||
    (diff.includes("---") && diff.includes("+++"))
  );
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Extract, apply the staged diff, install, mark phases, run the suite.
// apt output is silenced (it otherwise drowns the bounded evidence
// window); apt failure still aborts via set -e and lands in phase 'patch'.
export function buildApplyScript(
  manager: PackageManager,
  excluded: string[]
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const diff = shQuote(DIFF_STAGING_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  const invoke = manager === "pnpm" ? "pnpm test" : "npm test";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1; ` +
    `git apply ${diff}; echo ${PATCH_OK_MARKER}; ` +
    `${INSTALL_COMMANDS[manager]}; echo ${TEST_BEGIN_MARKER}; ${invoke}`
  );
}
