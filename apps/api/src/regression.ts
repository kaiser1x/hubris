// Phase F — regression test write + execution (first milestone).
//
// A regression test is caller-provided content or a Nemotron draft
// (generate:true, grounded on the twin). Either way it travels as a second
// uploaded file: the tarball maps to CHECKOUT_UPLOAD_PATH and the test
// content maps to REGRESSION_STAGING_PATH, then the script copies it into
// the extracted workspace AFTER `rm -rf` (files-map placement happens
// before the command runs, so mapping directly into the workspace would be
// wiped). Full suite runs it; evidence records pass/fail. No scoring.

import * as path from "path";
import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";
import { TEST_BEGIN_MARKER } from "./testrun";

// Fixed staging slot outside the workspace (survives the workspace reset).
export const REGRESSION_STAGING_PATH = "/tmp/hubris-upload/regression-test";

export const DEFAULT_REGRESSION_TEST_PATH = "tests/regression.test.ts";

// Workspace-relative destination for the test file. Strict by design:
// relative posix path, no traversal, test-file suffix only.
export function isSafeTestPath(p: string): boolean {
  if (p.length < 1 || p.length > 200) return false;
  if (p.includes("\\")) return false;
  if (p.startsWith("/") || p.startsWith(".")) return false;
  if (!(p.endsWith(".test.ts") || p.endsWith(".test.js"))) return false;
  const segs = p.split("/");
  if (segs.some((s) => s.length === 0 || s === "..")) return false;
  if (segs.some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) return false;
  return true;
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Extract, drop secret names, copy the staged test file into the workspace,
// install, mark the test phase, run the suite.
export function buildRegressionScript(
  manager: PackageManager,
  excluded: string[],
  testPath: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const staging = shQuote(REGRESSION_STAGING_PATH);
  const dest = shQuote(`${REPO_WORKDIR}/${testPath}`);
  const destDir = shQuote(
    testPath.includes("/")
      ? `${REPO_WORKDIR}/${path.posix.dirname(testPath)}`
      : REPO_WORKDIR
  );
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  const invoke = manager === "pnpm" ? "pnpm test" : "npm test";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `mkdir -p ${destDir}; cp ${staging} ${dest}; ` +
    `${INSTALL_COMMANDS[manager]}; echo ${TEST_BEGIN_MARKER}; ${invoke}`
  );
}
