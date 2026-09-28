// Phase H — Forge → Apply → Verify lifecycle (single-path, no engine).
//
// One endpoint, up to two disposable runs: stage the repo, VALIDATE the
// patch with `git apply --check`, and only then apply + install + verify.
// A failed check earns exactly ONE model redraft (same contract, plus the
// bounded git error); a second failure ends APPLY_FAILED. No loops.
// Verification rule (no scores, no percentages):
//   exit 0       → VERIFIED
//   non-zero     → FAILED
//   timeout      → TIMEOUT
// VERIFIED is recorded only when the sandbox actually returned exit 0.
// A patch that never applies ends APPLY_FAILED; an install failure that
// never reaches verification ends FAILED (never VERIFIED).

import { createHash } from "node:crypto";
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

// ---- Verification assessment (user-facing) ----
//
// "Target test passed" is repair evidence; "full suite passed" is regression
// evidence. The assessment never infers the first from the second. REPAIR
// VERIFIED requires an explicit targeted run of the exact investigated
// scenario to have passed. Anything that cannot be established is
// VERIFICATION_INCOMPLETE, never a generic failure.

export type VerificationAssessmentState =
  | "FULL_SUITE_PASSED"
  | "REPAIR_VERIFIED"
  | "REPAIR_NOT_VERIFIED"
  | "VERIFICATION_INCOMPLETE";

// Result of the targeted run of the exact investigated scenario.
export interface TargetVerificationInput {
  testFile: string;
  scenario: string;
  command: string;
  ran: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

export interface VerificationAssessment {
  state: VerificationAssessmentState;
  patchApplied: boolean;
  // null when it cannot be determined.
  targetVerificationPassed: boolean | null;
  // The investigated target test file / scenario, when the investigation
  // supplied them (never invented).
  targetTestFile: string | null;
  targetScenario: string | null;
  targetCommand: string | null;
  fullSuitePassed: boolean;
  // Failing test files that are NOT the investigated target test file.
  unrelatedTestFailures: number;
  // Failing test files parsed from the full-suite output (deduped).
  failedTests: string[];
  // The failing line for the target test, when the target run failed.
  targetFailure: string | null;
}

export const TARGET_VERIFY_DONE_MARKER = "TARGET_VERIFY_DONE";

// Parse the targeted-run completion marker. Absent marker ⇒ the targeted
// command never executed (context missing or unsupported runner).
export function parseTargetVerification(stdout: string): {
  ran: boolean;
  exitCode: number | null;
} {
  if (typeof stdout !== "string") return { ran: false, exitCode: null };
  const m = stdout.match(new RegExp(`^${TARGET_VERIFY_DONE_MARKER} (-?\\d+)$`, "m"));
  return m ? { ran: true, exitCode: Number(m[1]) } : { ran: false, exitCode: null };
}

export type TargetTestRunner = "vitest" | "jest";

// Detect the repo's test runner from its own test script. No global hardcode.
export function detectTestRunner(script: string | null | undefined): TargetTestRunner | null {
  const s = typeof script === "string" ? script.toLowerCase() : "";
  if (/\bvitest\b/.test(s)) return "vitest";
  if (/\bjest\b/.test(s)) return "jest";
  return null;
}

// Build a targeted command for the exact investigated scenario, using the
// detected package manager and runner. The test file and scenario are DATA,
// shell-quoted — never concatenated raw. Returns null when the runner is
// unsupported, so callers return VERIFICATION_INCOMPLETE.
export function buildTargetVerificationCommand(input: {
  manager: PackageManager;
  testScript: string | null;
  testFile: string | null;
  scenario: string | null;
}): string | null {
  if (!input.testFile || !input.scenario) return null;
  const runner = detectTestRunner(input.testScript);
  if (!runner) return null;
  const exec = input.manager === "pnpm" ? "pnpm exec" : "npx";
  const file = shQuote(input.testFile);
  const name = shQuote(input.scenario);
  return runner === "vitest"
    ? `${exec} vitest run ${file} -t ${name}`
    : `${exec} jest ${file} -t ${name}`;
}

// Normalize a test path for comparison: trim surrounding output, drop a
// leading "./", a trailing time/count suffix, and any `::test` selector.
export function normalizeTestPath(p: string | null | undefined): string | null {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  s = s.replace(/::.*$/, "");
  s = s.replace(/[),:(].*$/, "");
  return s.length > 0 ? s : null;
}

function sameTestFile(a: string, b: string): boolean {
  const na = normalizeTestPath(a);
  const nb = normalizeTestPath(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

// Extract failing test FILES from common runner output. Never throws; an
// unrecognized format yields [] (and therefore an unclassified verdict).
export function parseFailingTests(stdout: string): string[] {
  if (typeof stdout !== "string" || stdout.length === 0) return [];
  const out = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    // vitest / jest: "FAIL  tests/cart.test.ts > …" or "❯ tests/x.test.ts (…)"
    let m = line.match(/^(?:FAIL|❯|✕|✗)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/);
    if (m) {
      const n = normalizeTestPath(m[1]);
      if (n) out.add(n);
      continue;
    }
    // pytest: "FAILED tests/test_x.py::test_y - …"
    m = line.match(/^FAILED\s+([^\s:]+\.py)/);
    if (m) {
      const n = normalizeTestPath(m[1]);
      if (n) out.add(n);
    }
  }
  return [...out];
}

export function assessVerification(input: {
  patchApplied: boolean;
  verificationStarted: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  target?: TargetVerificationInput | null;
}): VerificationAssessment {
  const failedTests = parseFailingTests(input.stdout);
  const target = input.target ?? null;
  const targetTestFile = normalizeTestPath(target?.testFile ?? null);
  const targetScenario = target?.scenario?.trim() ? target.scenario.trim() : null;
  const targetCommand = target?.command ?? null;
  const fullSuitePassed =
    input.patchApplied &&
    input.verificationStarted &&
    !input.timedOut &&
    input.exitCode === 0;

  const base = {
    patchApplied: input.patchApplied,
    targetTestFile,
    targetScenario,
    targetCommand,
    failedTests,
  };

  if (!input.patchApplied) {
    return {
      ...base,
      state: "VERIFICATION_INCOMPLETE",
      targetVerificationPassed: null,
      fullSuitePassed: false,
      unrelatedTestFailures: 0,
      targetFailure: null,
    };
  }

  // With an explicit target run: TARGET FAILURE ALWAYS WINS.
  if (target && targetScenario) {
    const executed =
      target.ran && !target.timedOut && target.exitCode !== null && target.exitCode !== 127;
    if (target.timedOut || !executed) {
      // Fail closed: could not directly verify the investigated scenario.
      return {
        ...base,
        state: "VERIFICATION_INCOMPLETE",
        targetVerificationPassed: null,
        fullSuitePassed,
        unrelatedTestFailures: failedTests.filter((f) => !sameTestFile(f, targetTestFile ?? "")).length,
        targetFailure: null,
      };
    }
    if (target.exitCode !== 0) {
      return {
        ...base,
        state: "REPAIR_NOT_VERIFIED",
        targetVerificationPassed: false,
        fullSuitePassed,
        unrelatedTestFailures: failedTests.filter((f) => !sameTestFile(f, targetTestFile ?? "")).length,
        targetFailure:
          failedTests.find((f) => sameTestFile(f, targetTestFile ?? "")) ?? targetTestFile,
      };
    }
    // Target passed.
    if (fullSuitePassed) {
      return {
        ...base,
        state: "FULL_SUITE_PASSED",
        targetVerificationPassed: true,
        fullSuitePassed: true,
        unrelatedTestFailures: 0,
        targetFailure: null,
      };
    }
    if (input.timedOut) {
      // Fail closed: the regression run did not finish.
      return {
        ...base,
        state: "VERIFICATION_INCOMPLETE",
        targetVerificationPassed: true,
        fullSuitePassed: false,
        unrelatedTestFailures: 0,
        targetFailure: null,
      };
    }
    return {
      ...base,
      state: "REPAIR_VERIFIED",
      targetVerificationPassed: true,
      fullSuitePassed: false,
      unrelatedTestFailures: failedTests.filter((f) => !sameTestFile(f, targetTestFile ?? "")).length,
      targetFailure: null,
    };
  }

  // No target context (or unsupported runner): never claim REPAIR_VERIFIED.
  if (fullSuitePassed) {
    return {
      ...base,
      state: "FULL_SUITE_PASSED",
      targetVerificationPassed: null,
      fullSuitePassed: true,
      unrelatedTestFailures: 0,
      targetFailure: null,
    };
  }
  return {
    ...base,
    state: "VERIFICATION_INCOMPLETE",
    targetVerificationPassed: null,
    fullSuitePassed: false,
    unrelatedTestFailures: 0,
    targetFailure: null,
  };
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

export const CHECK_DONE_MARKER = "CHECK_DONE";

// Lean validation run: extract the tarball and run `git apply --check` on
// the staged diff. No install, no tests — it answers one question quickly:
// would the real apply accept this patch? Same workspace shape (exclusions)
// as the full run so the verdict transfers.
export function buildApplyCheckScript(excluded: string[]): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const diff = shQuote(DIFF_STAGING_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1; ` +
    `git apply --check ${diff}; echo ${CHECK_DONE_MARKER}`
  );
}

export interface ApplyCheckOutcome {
  passed: boolean;
  timedOut: boolean;
  // Bounded git output for the redraft prompt / evidence.
  error: string;
}

// exit 0 (and reached the marker) is the only pass. Anything else —
// nonzero, timeout, transport throw handled by the caller — is a fail.
export function parseApplyCheckResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): ApplyCheckOutcome {
  const passed =
    result.exitCode === 0 &&
    !result.timedOut &&
    result.stdout.includes(CHECK_DONE_MARKER);
  const error = `${result.stdout}\n${result.stderr}`.slice(0, 2000).trim();
  return { passed, timedOut: result.timedOut, error };
}

export interface GenerationAttempt {
  attempt: 1 | 2;
  source: "forge" | "forge-redraft" | "provided";
  patchSha256: string | null;
  patchBytes: number | null;
  parseAccepted: boolean;
  applyCheckPassed: boolean | null;
}

// Attempt records carry hashes and verdicts, never patch text or model
// prose — safe to persist and cheap to compare.
export function toAttemptRecord(input: {
  attempt: 1 | 2;
  source: "forge" | "forge-redraft" | "provided";
  diff: string | null;
  parseAccepted: boolean;
  applyCheckPassed: boolean | null;
}): GenerationAttempt {
  return {
    attempt: input.attempt,
    source: input.source,
    patchSha256:
      input.diff === null ? null : createHash("sha256").update(input.diff).digest("hex"),
    patchBytes: input.diff === null ? null : Buffer.byteLength(input.diff, "utf-8"),
    parseAccepted: input.parseAccepted,
    applyCheckPassed: input.applyCheckPassed,
  };
}

// Rejected-draft diagnostics (Phase I instrumentation). When a Forge draft
// carries no usable patch, the endpoint persists a SMALL, scrubbed preview
// so the next classification is evidence-based instead of inferential.
// Bounded (never the full output), secrets scrubbed, marked rejected.
// No forgeRuns[] entry: nothing executed, nothing to associate.
export const DRAFT_PREVIEW_CHARS = 2000;

export interface RejectedDraft {
  draftRejected: true;
  draftPreview: string;
  reason: string;
}

function scrubSecrets(text: string): string {
  // No leading word boundary: keys often arrive prefixed (NEBIUS_API_KEY).
  // Over-redaction in a diagnostic preview is acceptable; leakage is not.
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer <redacted>")
    .replace(
      /(api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1=<redacted>"
    );
}

export function buildRejectedDraftPreview(draft: string, reason = "no usable patch"): RejectedDraft {
  return {
    draftRejected: true,
    draftPreview: scrubSecrets(draft).slice(0, DRAFT_PREVIEW_CHARS),
    reason,
  };
}

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
