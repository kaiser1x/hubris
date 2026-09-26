// Phase H — Forge → Apply → Verify lifecycle (single-path, no engine).
//
// One endpoint, one disposable run: stage the repo, apply a patch (drafted
// by Forge or caller-provided), install, then run a verification command.
// Verification rule (no scores, no percentages):
//   exit 0       → VERIFIED
//   non-zero     → FAILED
//   timeout      → TIMEOUT
// VERIFIED is recorded only when the sandbox actually returned exit 0.
// A patch that never applies ends APPLY_FAILED; an install failure that
// never reaches verification ends FAILED (never VERIFIED).

import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";
import { DIFF_STAGING_PATH, PATCH_OK_MARKER } from "./apply";
import type { ForgeContext } from "@hubris/llm";

export type ForgeStatus =
  | "PROPOSED"
  | "APPLYING"
  | "APPLIED"
  | "VERIFYING"
  | "VERIFIED"
  | "APPLY_FAILED"
  | "FAILED"
  | "TIMEOUT";

export interface RunSignals {
  patchOk: boolean;
  verifyBegin: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

// Explicit transition table over end-of-run signals. The intermediate
// states exist during execution; the persisted record keeps the trail.
export function resolveForgeStatus(s: RunSignals): ForgeStatus {
  if (!s.patchOk) return "APPLY_FAILED";
  if (!s.verifyBegin) return "FAILED";
  if (s.timedOut) return "TIMEOUT";
  return s.exitCode === 0 ? "VERIFIED" : "FAILED";
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Extract, apply the staged diff, install, mark phases, run the
// verification invocation (repo suite by default, explicit command wins).
export function buildForgeVerifyScript(
  manager: PackageManager,
  excluded: string[],
  verifyInvoke: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const diff = shQuote(DIFF_STAGING_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1; ` +
    `git apply ${diff}; echo ${PATCH_OK_MARKER}; ` +
    `${INSTALL_COMMANDS[manager]}; ` +
    `echo ${VERIFY_BEGIN_MARKER}; ${verifyInvoke}`
  );
}

export const VERIFY_BEGIN_MARKER = "VERIFY_BEGIN";

// Twin shape shared by /api/forge and /api/forge-verify so the proposal
// and the verified run always ground on the same prompt. Behavior of the
// existing forge handler is unchanged; it now delegates here.
export interface TwinJobLike {
  repoUrl: string;
  status?: string | null;
  result: {
    repository?: { name?: string };
    stats?: { functions: number; classes: number; endpoints: number; tests: number; relationships: number };
    full?: {
      functions?: Array<{ name?: string; path?: string; line?: number }>;
      endpoints?: Array<{ method?: string; path?: string }>;
      relationships?: Array<{ from?: string; to?: string; type?: string }>;
    };
  } | null;
}

function shortPath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-3).join("/");
}

export function getForgeContext(
  job: TwinJobLike,
  focus?: string,
  instruction?: string
): ForgeContext | null {
  const result = job.result;
  if (job.status !== "complete" || !result?.stats) return null;
  const fullFunctions = result.full?.functions ?? [];
  return {
    repoName: result.repository?.name ?? job.repoUrl,
    stats: result.stats,
    functions: fullFunctions.map((f) => ({
      name: f.name ?? "(anonymous)",
      file: f.path ? shortPath(f.path) : "(unknown)",
      line: f.line ?? 1,
    })),
    endpoints: (result.full?.endpoints ?? []).map((e) =>
      `${e.method ?? ""} ${e.path ?? ""}`.trim()
    ).filter(Boolean),
    relationships: (result.full?.relationships ?? []).map((r) =>
      `${r.from ? shortPath(r.from) : "?"} ${r.type ?? "?"} ${r.to ?? "?"}`
    ),
    ...(focus !== undefined ? { focus } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
  };
}

export { shortPath };
