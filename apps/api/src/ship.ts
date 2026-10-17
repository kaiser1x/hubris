// SHIP — publish an already-verified Forge repair as a GitHub Pull Request.
//
// Safety-critical. SHIP publishes the EXACT patch Forge validated and applied
// in its disposable sandbox. It never regenerates the patch, never uses an
// LLM, never force-pushes, never touches the default branch, never merges, and
// fails closed on any provenance or integrity mismatch. Credentials never
// appear in logs, errors, PR bodies, or persisted records.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SHIP_BRANCH_PREFIX = "hubris/";
const BRANCH_MAX = 100;

export interface Verdict {
  ok: boolean;
  reason: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---- canonical patch integrity ----

export interface CanonicalPatchLike {
  sha?: unknown;
  bytes?: unknown;
  content?: unknown;
}

export function verifyCanonicalPatch(
  patch: CanonicalPatchLike | null | undefined
): { ok: boolean; reason: string; content: string | null } {
  if (!patch || typeof patch !== "object") {
    return { ok: false, reason: "Canonical patch is missing.", content: null };
  }
  const content = typeof patch.content === "string" ? patch.content : null;
  const sha = typeof patch.sha === "string" ? patch.sha : null;
  const bytes = typeof patch.bytes === "number" ? patch.bytes : null;
  if (!content) return { ok: false, reason: "Canonical patch content was not persisted.", content: null };
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) {
    return { ok: false, reason: "Canonical patch SHA is missing or malformed.", content: null };
  }
  if (sha256Hex(content) !== sha) {
    return { ok: false, reason: "Canonical patch SHA does not match its content.", content: null };
  }
  if (bytes !== null && Buffer.byteLength(content, "utf-8") !== bytes) {
    return { ok: false, reason: "Canonical patch byte count does not match its content.", content: null };
  }
  return { ok: true, reason: "", content };
}

// ---- eligibility (assessment + apply + patch) ----

const ELIGIBLE_STATES = new Set(["REPAIR_VERIFIED", "FULL_SUITE_PASSED"]);

export interface ForgeRunLike {
  id?: unknown;
  investigationId?: unknown;
  apply?: unknown;
  verification?: unknown;
  targetVerification?: unknown;
  canonicalPatch?: unknown;
  source?: unknown;
}

export function shipEligibility(run: ForgeRunLike | null | undefined): Verdict {
  if (!run || typeof run !== "object") return { ok: false, reason: "Forge run not found." };
  const apply = isRecord(run.apply) ? run.apply : null;
  const verification = isRecord(run.verification) ? run.verification : null;
  const assessment = verification && isRecord(verification.assessment) ? verification.assessment : null;
  if (!assessment || typeof assessment.state !== "string") {
    return {
      ok: false,
      reason: "This Forge run predates verification assessment; it cannot be shipped.",
    };
  }
  if (!ELIGIBLE_STATES.has(assessment.state)) {
    return { ok: false, reason: `The repair is not verified (${assessment.state}). Re-run Forge.` };
  }
  if (assessment.targetVerificationPassed === false) {
    return { ok: false, reason: "Target verification must pass before shipping; the investigated behavior did not pass verification." };
  }
  // REPAIR_VERIFIED means "target passed, full suite has unrelated failures":
  // the target pass is its only proof, so it must be confirmed explicitly.
  // Missing/null/undefined fails closed — never inferred from the label, the
  // raw record, or the regression suite. (FULL_SUITE_PASSED is proven by the
  // whole suite passing and may legitimately have no targeted run.)
  if (assessment.state === "REPAIR_VERIFIED" && assessment.targetVerificationPassed !== true) {
    return {
      ok: false,
      reason: "Target verification must pass before shipping; no confirmed target pass was recorded. Re-run Forge.",
    };
  }
  if (apply?.applied !== true) {
    return { ok: false, reason: "The patch was not applied in the sandbox." };
  }
  const patch = verifyCanonicalPatch(run.canonicalPatch as CanonicalPatchLike);
  if (!patch.ok) return { ok: false, reason: patch.reason };
  return { ok: true, reason: "" };
}

// ---- provenance gate ----

export interface ShipProvenanceContext {
  repository: string;
  jobRepoUrl: string | null;
  investigationId: string | null;
}

export function verifyShipProvenance(
  run: ForgeRunLike | null | undefined,
  ctx: ShipProvenanceContext
): Verdict {
  if (!run || typeof run !== "object") return { ok: false, reason: "Forge run not found." };
  const source = isRecord(run.source) ? run.source : null;
  const runRepoUrl = typeof source?.repoUrl === "string" ? source.repoUrl : null;
  if (!runRepoUrl || repoNameFromCloneUrl(runRepoUrl) !== ctx.repository) {
    return { ok: false, reason: "Repository does not match the Forge run." };
  }
  if (!ctx.jobRepoUrl || repoNameFromCloneUrl(ctx.jobRepoUrl) !== ctx.repository) {
    return { ok: false, reason: "Repository does not match the analyzed job." };
  }
  const investigationId = typeof run.investigationId === "string" ? run.investigationId : null;
  if (!investigationId || investigationId !== ctx.investigationId) {
    return { ok: false, reason: "Investigation does not match the Forge run." };
  }
  const analyzed =
    typeof source?.analysisCommitSha === "string" ? source.analysisCommitSha : null;
  const execution =
    typeof source?.executionCommitSha === "string"
      ? source.executionCommitSha
      : typeof source?.commitSha === "string"
        ? source.commitSha
        : null;
  if (!analyzed || !/^[a-f0-9]{40}$/.test(analyzed)) {
    return { ok: false, reason: "Analyzed commit is missing." };
  }
  if (!execution || !/^[a-f0-9]{40}$/.test(execution)) {
    return { ok: false, reason: "Execution commit is missing." };
  }
  if (analyzed !== execution) {
    return { ok: false, reason: "Analyzed and execution commits differ." };
  }
  return { ok: true, reason: "" };
}

// ---- branch naming ----

export function slugify(value: string, maxWords = 5): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 48);
}

// Deterministic branch: hubris/fix/<function>-<report words>-<short id>.
export function shipBranchName(
  targetFunction: string,
  report: string,
  investigationId: string | null
): string {
  const fnSlug = slugify(targetFunction, 3);
  const reportSlug = slugify(report, 4);
  const base = [fnSlug, reportSlug].filter(Boolean).join("-") || "repair";
  const shortId = (investigationId ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  let name = `${SHIP_BRANCH_PREFIX}fix/${base}`;
  if (shortId) name = `${name}-${shortId}`;
  if (name.length > BRANCH_MAX) name = name.slice(0, BRANCH_MAX).replace(/[-./]+$/, "");
  return name;
}

export function isSafeShipBranch(name: string): boolean {
  if (typeof name !== "string") return false;
  if (!name.startsWith(SHIP_BRANCH_PREFIX)) return false;
  if (name.length < SHIP_BRANCH_PREFIX.length + 1 || name.length > 150) return false;
  if (name.includes(" ") || name.includes("..")) return false;
  return /^hubris\/[A-Za-z0-9._/-]+$/.test(name);
}

// Is `candidate` a safe branch name that does not collide with `existing`?
export function uniqueShipBranch(candidate: string, existing: string[], attempt = 0): string {
  const suffix = attempt === 0 ? "" : `-${attempt}`;
  const next = `${candidate}${suffix}`;
  return existing.includes(next) ? uniqueShipBranch(candidate, existing, attempt + 1) : next;
}

// ---- PR metadata (deterministic, from persisted evidence) ----

export function buildPullRequestTitle(targetFunction: string, report: string): string {
  const fn = (targetFunction || "").trim();
  const words = (report || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  const summary = words || "verified repair";
  return fn ? `Fix ${fn}: ${summary}` : `Fix: ${summary}`;
}

// The FINAL Forge target-verification result for the PR body. The authoritative
// result is the assessment (targetVerificationPassed); the raw persisted
// targetVerification record may lack `passed`, which previously produced a
// stale "NOT VERIFIED" even when the target passed.
export function targetVerificationForBody(run: ForgeRunLike): {
  scenario: string | null;
  testFile: string | null;
  passed: boolean | null;
} {
  const verification = isRecord(run?.verification) ? run.verification : null;
  const assessment = verification && isRecord(verification.assessment) ? verification.assessment : null;
  const tv = isRecord(run?.targetVerification) ? run.targetVerification : null;
  const passed =
    assessment && typeof assessment.targetVerificationPassed === "boolean"
      ? assessment.targetVerificationPassed
      : tv && typeof tv.passed === "boolean"
        ? tv.passed
        : null;
  const scenario =
    (assessment && typeof assessment.targetScenario === "string" ? assessment.targetScenario : null) ??
    (tv && typeof tv.scenario === "string" ? tv.scenario : null);
  const testFile =
    (assessment && typeof assessment.targetTestFile === "string" ? assessment.targetTestFile : null) ??
    (tv && typeof tv.testFile === "string" ? tv.testFile : null);
  return { scenario, testFile, passed };
}

export interface PullRequestBodyInput {
  repoName: string;
  targetFunction: string;
  targetFile: string;
  currentBehavior: string;
  expectedBehavior: string;
  targetVerification: {
    scenario: string | null;
    testFile: string | null;
    passed: boolean | null;
  };
  regression: {
    fullSuitePassed: boolean;
    unrelatedTestFailures: number;
    failedTests: string[];
  };
  provenance: {
    investigationId: string;
    forgeRunId: string;
    analyzedCommitSha: string;
    executionCommitSha: string;
    canonicalPatchSha: string;
    assessment: string;
  };
}

// PR body is built ONLY from persisted evidence; it never claims the full
// suite passed when it did not, and never calls failures "pre-existing".
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const lines: string[] = [];
  lines.push("## HUBRIS Repair", "");
  lines.push("### Reported behavior", "");
  lines.push(input.currentBehavior || "(reported behavior unavailable)", "");
  lines.push("### Target", "");
  lines.push("`" + input.targetFile + "` → `" + input.targetFunction + "()`", "");
  lines.push("### Expected behavior", "");
  lines.push(input.expectedBehavior || "(expected behavior unavailable)", "");
  lines.push("### Target verification", "");
  lines.push(`- Scenario: \`${input.targetVerification.scenario ?? "(none recorded)"}\``);
  lines.push(`- Test: \`${input.targetVerification.testFile ?? "(none recorded)"}\``);
  lines.push(`- Result: ${input.targetVerification.passed === true ? "PASSED" : "NOT VERIFIED"}`);
  lines.push("");
  lines.push("### Regression suite", "");
  lines.push(`- Result: ${input.regression.fullSuitePassed ? "PASSED" : "FAILED"}`);
  if (!input.regression.fullSuitePassed) {
    lines.push(`- Unrelated failures: ${input.regression.unrelatedTestFailures}`);
    if (input.regression.failedTests.length > 0) {
      lines.push("");
      lines.push("Unrelated:");
      for (const t of input.regression.failedTests) lines.push(`- \`${t}\``);
    }
  }
  lines.push("");
  lines.push("### HUBRIS provenance", "");
  lines.push(`- Investigation ID: \`${input.provenance.investigationId}\``);
  lines.push(`- Forge run: \`${input.provenance.forgeRunId}\``);
  lines.push(`- Analyzed commit: \`${input.provenance.analyzedCommitSha}\``);
  lines.push(`- Execution commit: \`${input.provenance.executionCommitSha}\``);
  lines.push(`- Canonical patch SHA: \`${input.provenance.canonicalPatchSha}\``);
  lines.push(`- Assessment: \`${input.provenance.assessment}\``);
  lines.push("");
  lines.push("---");
  lines.push(
    "_Created by HUBRIS from a verified repair. HUBRIS did not merge this and will not modify the base branch._"
  );
  return lines.join("\n");
}

export interface PullRequestBodyRunContext {
  repoName: string;
  targetFunction: string;
  targetFile: string;
  currentBehavior: string;
  expectedBehavior: string;
  investigationId: string;
  forgeRunId: string;
  analyzedCommitSha: string;
  executionCommitSha: string;
  canonicalPatchSha: string;
}

// Build the PR body from the EXACT finalized Forge run being shipped. Target
// verification, regression results, and the assessment all come from the run's
// final assessment — never from the investigation's older verification state.
export function buildPullRequestBodyFromRun(run: ForgeRunLike, ctx: PullRequestBodyRunContext): string {
  const verification = isRecord(run?.verification) ? run.verification : null;
  const assessment = verification && isRecord(verification.assessment) ? verification.assessment : {};
  return buildPullRequestBody({
    repoName: ctx.repoName,
    targetFunction: ctx.targetFunction,
    targetFile: ctx.targetFile,
    currentBehavior: ctx.currentBehavior,
    expectedBehavior: ctx.expectedBehavior,
    targetVerification: targetVerificationForBody(run),
    regression: {
      fullSuitePassed: assessment.fullSuitePassed === true,
      unrelatedTestFailures:
        typeof assessment.unrelatedTestFailures === "number" ? assessment.unrelatedTestFailures : 0,
      failedTests: Array.isArray(assessment.failedTests)
        ? assessment.failedTests.filter((t): t is string => typeof t === "string")
        : [],
    },
    provenance: {
      investigationId: ctx.investigationId,
      forgeRunId: ctx.forgeRunId,
      analyzedCommitSha: ctx.analyzedCommitSha,
      executionCommitSha: ctx.executionCommitSha,
      canonicalPatchSha: ctx.canonicalPatchSha,
      assessment: typeof assessment.state === "string" ? assessment.state : "",
    },
  });
}

export interface PullRequestRecord {
  provider: "github";
  repository: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  investigationId: string;
  forgeRunId: string;
  canonicalPatchSha: string;
  createdAt: string;
  status: "OPEN";
}

// Existing HUBRIS PR for the same (repository, investigationId, patch) — a
// duplicate must never be created.
export function findExistingPullRequest(
  runs: unknown[],
  key: { repository: string; investigationId: string | null; canonicalPatchSha: string }
): PullRequestRecord | null {
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const pr = isRecord(run.pullRequest) ? run.pullRequest : null;
    if (!pr) continue;
    if (
      pr.repository === key.repository &&
      pr.investigationId === key.investigationId &&
      pr.canonicalPatchSha === key.canonicalPatchSha
    ) {
      return pr as unknown as PullRequestRecord;
    }
  }
  return null;
}

// ---- credential handling ----

export function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.GITHUB_TOKEN;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

export function repoNameFromCloneUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const parts = url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function authedCloneUrl(repository: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repository}.git`;
}

// Scrub credentials from any string before it can reach a log/error/record.
export function redactSecrets(text: string, token?: string | null): string {
  let out = typeof text === "string" ? text : "";
  if (token) out = out.split(token).join("<redacted>");
  out = out.replace(/x-access-token:[^@]+@/gi, "x-access-token:<redacted>@");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer <redacted>");
  return out;
}

// ---- GitHub API (injectable fetch) ----

export interface GitHubPullRequest {
  number: number;
  html_url: string;
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; status: number; data: unknown; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "HUBRIS/0.1.0",
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error: unknown) {
    return { ok: false, status: 0, data: null, error: redactSecrets(error instanceof Error ? error.message : String(error), token) };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = isRecord(data) && typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
    return { ok: false, status: res.status, data, error: redactSecrets(message, token) };
  }
  return { ok: true, status: res.status, data, error: "" };
}

export async function getDefaultBranch(
  token: string,
  repository: string,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; branch: string | null; error: string; status: number }> {
  const res = await githubRequest(token, "GET", `/repos/${repository}`, undefined, fetchImpl);
  if (!res.ok) return { ok: false, branch: null, error: res.error, status: res.status };
  const branch = isRecord(res.data) && typeof res.data.default_branch === "string" ? res.data.default_branch : null;
  return branch
    ? { ok: true, branch, error: "", status: res.status }
    : { ok: false, branch: null, error: "Default branch could not be resolved.", status: res.status };
}

export async function findOpenPullRequestForBranch(
  token: string,
  repository: string,
  owner: string,
  branch: string,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; pr: GitHubPullRequest | null; error: string; status: number }> {
  const res = await githubRequest(
    token,
    "GET",
    `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    undefined,
    fetchImpl
  );
  if (!res.ok) return { ok: false, pr: null, error: res.error, status: res.status };
  const list = Array.isArray(res.data) ? res.data : [];
  const first = list.find((p) => isRecord(p) && typeof p.number === "number" && typeof p.html_url === "string");
  return {
    ok: true,
    pr: first ? { number: (first as { number: number }).number, html_url: (first as { html_url: string }).html_url } : null,
    error: "",
    status: res.status,
  };
}

export async function createGitHubPullRequest(
  token: string,
  repository: string,
  input: { title: string; body: string; head: string; base: string },
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; pr: GitHubPullRequest | null; error: string; status: number }> {
  const res = await githubRequest(token, "POST", `/repos/${repository}/pulls`, input, fetchImpl);
  if (!res.ok) return { ok: false, pr: null, error: res.error, status: res.status };
  const pr =
    isRecord(res.data) && typeof res.data.number === "number" && typeof res.data.html_url === "string"
      ? { number: res.data.number, html_url: res.data.html_url }
      : null;
  return pr ? { ok: true, pr, error: "", status: res.status } : { ok: false, pr: null, error: "Pull request response was malformed.", status: res.status };
}

// ---- orchestration (injectable git/fetch/fs for tests) ----

export interface ShipDeps {
  exec: (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  fetchImpl: typeof fetch;
  tmpDir: () => Promise<string>;
  removeDir: (dir: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export const defaultShipDeps: ShipDeps = {
  exec: (args, opts) =>
    execFileAsync("git", args, { cwd: opts?.cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }).then(
      (r) => ({ stdout: r.stdout, stderr: r.stderr })
    ),
  fetchImpl: fetch,
  tmpDir: async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    return fs.mkdtemp(path.join(os.tmpdir(), "hubris-ship-"));
  },
  removeDir: async (dir) => {
    const fs = await import("node:fs/promises");
    await fs.rm(dir, { recursive: true, force: true });
  },
  writeFile: async (path, content) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, content, "utf-8");
  },
};

export interface ShipRunInput {
  repository: string;
  owner: string;
  commitSha: string;
  baseBranch: string;
  branch: string;
  patchContent: string;
  canonicalPatchSha: string;
  title: string;
  body: string;
  token: string;
}

export type ShipPushStatus = "PUSHED" | "ALREADY_PUSHED";
export type ShipBlockKind = "conflict" | "auth" | "blocked";

export interface ShipRunResult {
  ok: boolean;
  reason: string;
  // Why a non-ok result blocked: a remote-branch conflict, a GitHub
  // authorization problem (action required), or another hard blocker.
  kind?: ShipBlockKind;
  pushStatus?: ShipPushStatus;
  pullRequest?: PullRequestRecord;
  duplicate?: PullRequestRecord;
}

// Resolve the SHA of a specific remote branch from `git ls-remote origin
// refs/heads/<branch>` output. Absent branch → null. Never throws.
export function parseRemoteBranchSha(stdout: string, branch: string): string | null {
  if (typeof stdout !== "string") return null;
  const refName = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === refName && /^[a-f0-9]{40}$/.test(parts[0])) {
      return parts[0];
    }
  }
  return null;
}

// Clone at the exact analyzed commit, apply ONLY the persisted canonical patch,
// prove the resulting diff is byte-identical, then push a hubris/* branch and
// open a PR. Any deviation stops before pushing. No force-push, no default
// branch modification, no merge.
export async function shipForgeRun(
  input: ShipRunInput,
  deps: ShipDeps = defaultShipDeps
): Promise<ShipRunResult> {
  if (!isSafeShipBranch(input.branch)) {
    return { ok: false, reason: "Refusing to push: branch name is not a safe hubris/* branch." };
  }
  if (input.branch === input.baseBranch) {
    return { ok: false, reason: "Refusing to push: the branch equals the base branch." };
  }
  if (!/^[a-f0-9]{40}$/.test(input.commitSha)) {
    return { ok: false, reason: "Analyzed commit is not a valid SHA." };
  }

  const dir = await deps.tmpDir();
  const url = authedCloneUrl(input.repository, input.token);
  const patchFile = `${dir}.patch`;
  try {
    // Stale check: the exact analyzed commit must still exist in the remote.
    try {
      await deps.exec(["init", "-q", dir]);
      await deps.exec(["remote", "add", "origin", url], { cwd: dir });
      await deps.exec(["fetch", "--depth", "1", "origin", input.commitSha], { cwd: dir });
      await deps.exec(["checkout", "--detach", input.commitSha], { cwd: dir });
    } catch {
      return {
        ok: false,
        reason: "Repository changed since this repair was verified. Re-run Forge before creating a pull request.",
      };
    }
    // Base branch must not have advanced (fail closed — never silently rebase).
    try {
      await deps.exec(["fetch", "--depth", "1", "origin", input.baseBranch], { cwd: dir });
      const base = await deps.exec(["rev-parse", "--verify", `origin/${input.baseBranch}`], { cwd: dir });
      if (base.stdout.trim() !== input.commitSha) {
        return {
          ok: false,
          reason: "Repository changed since this repair was verified. Re-run Forge before creating a pull request.",
        };
      }
    } catch {
      return {
        ok: false,
        reason: "Repository changed since this repair was verified. Re-run Forge before creating a pull request.",
      };
    }

    await deps.exec(["checkout", "-b", input.branch], { cwd: dir });
    await deps.writeFile(patchFile, input.patchContent);
    try {
      await deps.exec(["apply", "--index", patchFile], { cwd: dir });
    } catch (error) {
      return { ok: false, reason: redactSecrets(`The verified patch did not apply: ${error instanceof Error ? error.message : String(error)}`, input.token) };
    }
    // The resulting staged diff must be byte-identical to the verified patch.
    const diff = await deps.exec(["diff", "--cached"], { cwd: dir });
    if (sha256Hex(diff.stdout) !== input.canonicalPatchSha) {
      return { ok: false, reason: "The reproduced patch does not match the verified canonical patch." };
    }
    try {
      await deps.exec(["diff", "--cached", "--check"], { cwd: dir });
    } catch {
      return { ok: false, reason: "The reproduced patch failed git diff --check." };
    }
    // Nothing may be modified outside the patch (index equals worktree).
    const unstaged = await deps.exec(["diff", "--name-only"], { cwd: dir });
    if (unstaged.stdout.trim().length > 0) {
      return { ok: false, reason: "Unexpected working-tree changes beyond the verified patch." };
    }

    await deps.exec(["-c", "user.email=hubris@localhost", "-c", "user.name=HUBRIS", "commit", "-qm", input.title], { cwd: dir });
    // Idempotent push: resolve local HEAD and check the remote branch FIRST.
    // If it already points at HEAD, the earlier push succeeded — skip the push
    // (never pull, never force). A different remote SHA is a hard conflict.
    const headRes = await deps.exec(["rev-parse", "HEAD"], { cwd: dir });
    const localHead = headRes.stdout.trim();
    const lsRemote = await deps.exec(["ls-remote", "origin", `refs/heads/${input.branch}`], { cwd: dir });
    const remoteSha = parseRemoteBranchSha(lsRemote.stdout, input.branch);
    let pushStatus: ShipPushStatus = "PUSHED";
    if (remoteSha && remoteSha === localHead) {
      pushStatus = "ALREADY_PUSHED";
    } else if (remoteSha) {
      return {
        ok: false,
        kind: "conflict",
        reason: `The remote branch "${input.branch}" already contains different work. HUBRIS will not reuse or overwrite that branch — run Forge again to get a new repair branch.`,
      };
    } else {
      try {
        // Push ONLY the hubris/* branch. No --force, no default branch, no pull.
        await deps.exec(["push", "origin", `HEAD:refs/heads/${input.branch}`], { cwd: dir });
      } catch (error) {
        return {
          ok: false,
          kind: "blocked",
          reason: redactSecrets(`Push was rejected: ${error instanceof Error ? error.message : String(error)}`, input.token),
        };
      }
    }

    const existing = await findOpenPullRequestForBranch(input.token, input.repository, input.owner, input.branch, deps.fetchImpl);
    if (!existing.ok) {
      if (existing.status === 401 || existing.status === 403) {
        return { ok: false, kind: "auth", pushStatus, reason: "GitHub authorization required. HUBRIS could not read the pull request state." };
      }
      return { ok: false, kind: "blocked", pushStatus, reason: redactSecrets(`GitHub error: ${existing.error}`, input.token) };
    }
    if (existing.pr) {
      return {
        ok: true,
        pushStatus,
        reason: "A pull request already exists for this repair.",
        duplicate: {
          provider: "github",
          repository: input.repository,
          branch: input.branch,
          baseBranch: input.baseBranch,
          commitSha: input.commitSha,
          prNumber: existing.pr.number,
          prUrl: existing.pr.html_url,
          investigationId: "",
          forgeRunId: "",
          canonicalPatchSha: input.canonicalPatchSha,
          createdAt: new Date().toISOString(),
          status: "OPEN",
        },
      };
    }

    const created = await createGitHubPullRequest(
      input.token,
      input.repository,
      { title: input.title, body: input.body, head: input.branch, base: input.baseBranch },
      deps.fetchImpl
    );
    if (!created.ok || !created.pr) {
      if (created.status === 401 || created.status === 403) {
        return {
          ok: false,
          kind: "auth",
          pushStatus,
          reason: "GitHub authorization required. HUBRIS could not create the pull request with the configured token.",
        };
      }
      const reason =
        created.status === 422
          ? "GitHub rejected the pull request (it may already exist for this branch)."
          : `Pull request creation failed: ${created.error}`;
      return { ok: false, kind: "blocked", pushStatus, reason: redactSecrets(reason, input.token) };
    }
    return {
      ok: true,
      pushStatus,
      reason: "Pull request created.",
      pullRequest: {
        provider: "github",
        repository: input.repository,
        branch: input.branch,
        baseBranch: input.baseBranch,
        commitSha: input.commitSha,
        prNumber: created.pr.number,
        prUrl: created.pr.html_url,
        investigationId: "",
        forgeRunId: "",
        canonicalPatchSha: input.canonicalPatchSha,
        createdAt: new Date().toISOString(),
        status: "OPEN",
      },
    };
  } finally {
    await deps.removeDir(dir).catch(() => undefined);
    await deps.removeDir(patchFile).catch(() => undefined);
  }
}
