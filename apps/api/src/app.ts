import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { analyzeRepository } from "@hubris/analyzer";
import { getDb, schema } from "@hubris/db";
import {
  FORGE_SYSTEM,
  INVESTIGATE_SYSTEM,
  ModelError,
  REDRAFT_SYSTEM,
  REGRESSION_SYSTEM,
  buildForgePrompt,
  buildInvestigatePrompt,
  buildRedraftPrompt,
  buildRegressionPrompt,
  buildStructuredPrompt,
  chatComplete,
  extractForgePatch,
  forgeMaxTokens,
  llmConfigFromEnv,
  stripCodeFences,
  STRUCTURED_SYSTEM,
} from "@hubris/llm";
import { createHash } from "crypto";
import { executionLimitsFromEnv, isSafeGitRef, isSandboxWaitTimeout, REPO_WORKDIR, sandboxConfigFromEnv, uploadFile } from "@hubris/sandbox";
import {
  buildCheckoutScript,
  CHECKOUT_UPLOAD_PATH,
  cloneAndArchive,
  isTransferExcluded,
  limitsFromEnv,
  parseCheckoutListing,
} from "./checkout";
import {
  buildInstallScript,
  detectManager,
  installTimingFromEnv,
  type PackageManager,
} from "./install";
import {
  buildTestScript,
  readPackageTestScript,
  TEST_BEGIN_MARKER,
  testTimingFromEnv,
} from "./testrun";
import {
  assessVerification,
  buildApplyCheckScript,
  buildForgeVerifyScript,
  buildRejectedDraftPreview,
  buildTargetVerificationCommand,
  getForgeContext,
  parseApplyCheckResult,
  parseTargetVerification,
  resolveForgeStatus,
  toAttemptRecord,
  VERIFY_BEGIN_MARKER,
  type TargetVerificationInput,
  type TwinJobLike,
} from "./forgeverify";
import {
  buildSourceExcerpts,
  buildStructuredScript,
  EditPlanSchema,
  isEmptyEditPlan,
  isSupportedEditPath,
  parseCanonicalPatchContent,
  parseSourceMarkers,
  parseStructuredRun,
  resolveJobCommitSha,
  resolveJobRef,
  sourceMarkersMatch,
  STRUCTURED_UPLOAD_EDITS,
  STRUCTURED_UPLOAD_VALIDATOR,
  VALIDATOR_JS,
} from "./structured";
import { composeForgeFocus, isGroundedRepairContract } from "./investigate";
import {
  resolveClarificationAnswer,
  runInvestigationAgent,
  type ClarificationAnswerResolution,
} from "./investigate-agent";
import {
  buildRegressionScript,
  DEFAULT_REGRESSION_TEST_PATH,
  isSafeTestPath,
  REGRESSION_STAGING_PATH,
} from "./regression";
import {
  buildApplyScript,
  DIFF_STAGING_PATH,
  isPlausibleDiff,
  PATCH_OK_MARKER,
} from "./apply";
import {
  buildVerifyScript,
  buildReproScript,
  classifyReproduction,
  classifyVerification,
  REPRO_BEGIN_MARKER,
} from "./reproduce";
import { describeSourceMismatch } from "./mismatch";
import { GIT_UNAVAILABLE_MESSAGE, isMissingBinary } from "./gitenv";
import { DEFAULT_PROBE_REPO, isSafeProbeUrl, runGitDiagnostics, type GitDiagReport } from "./gitdiag";
import { demoGuard, demoSessionOf } from "./demo";
import {
  apiKeyGuard,
  budgetSignal,
  coldStartGitCheck,
  MIN_SANDBOX_BUDGET_MS,
  readiness,
  remainingBudgetMs,
  requestBudget,
  runCommandWithinBudget as runCommand,
} from "./runtime";
import {
  buildPullRequestBodyFromRun,
  buildPullRequestTitle,
  findExistingPullRequest,
  getDefaultBranch,
  githubTokenFromEnv,
  redactSecrets,
  repoNameFromCloneUrl as shipRepoNameFromCloneUrl,
  resolveShipBase,
  shipBranchName,
  shipEligibility,
  shipForgeRun,
  uniqueShipBranch,
  verifyCanonicalPatch,
  verifyShipProvenance,
  type ForgeRunLike,
  type PullRequestRecord,
} from "./ship";

const execFileAsync = promisify(execFile);

function packageJsonScripts(repoPath: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(raw.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

function readyInvestigation(result: unknown, investigationId: string): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null) return null;
  const runs = (result as { investigationRuns?: unknown[] }).investigationRuns;
  if (!Array.isArray(runs)) return null;
  const found = runs.find(
    (run): run is Record<string, unknown> =>
      typeof run === "object" &&
      run !== null &&
      (run as Record<string, unknown>).investigationId === investigationId
  );
  return found && found.status === "READY" ? found : null;
}

// Only public github.com repos. Returns a normalized clone URL or null.
export function toSafeCloneUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com")
      return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (!/^[\w.-]+$/.test(owner)) return null;
    const name = repo.replace(/\.git$/, "");
    if (!/^[\w.-]+$/.test(name)) return null;
    return `https://github.com/${owner}/${name}.git`;
  } catch {
    return null;
  }
}

const GitRef = z
  .string()
  .max(100)
  .refine((r) => isSafeGitRef(r), "Invalid ref");

const AnalyzeBody = z.object({
  repoUrl: z.string().min(1, "repoUrl is required"),
  // Optional branch/tag so a job can pin a non-default ref (e.g. a bug
  // fixture branch). The twin then describes exactly what later stages
  // check out. Same safe-ref contract as the other endpoints.
  ref: GitRef.optional(),
});

const InvestigateBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  question: z.string().max(2000).optional(),
  // Structured investigation mode: a natural-language bug description
  // grounded deterministically against the CodeTwin (no model call).
  // When present and non-empty, the endpoint returns a strict
  // READY | AMBIGUOUS | NO_MATCH verdict instead of a prose answer.
  focus: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => value.trim().length > 0, "focus is required")
    .optional(),
  // Conversational clarification: when a prior run returned
  // CLARIFICATION_NEEDED, the client resubmits the same report plus the
  // focused question and the user's answer. The agent resumes instead of
  // asking the user to restate the whole bug.
  priorQuestion: z.string().max(500).optional(),
  clarification: z.string().max(500).optional(),
  // Structured answer (preferred): the investigation that asked the question
  // plus the stable question/option ids. Validated server-side against the
  // persisted question; the selected scenario/target is pinned into the
  // evidence the contract is built from.
  priorInvestigationId: z.string().min(1).max(64).optional(),
  answer: z
    .object({
      questionId: z.string().min(1).max(64),
      optionId: z.string().min(1).max(64),
    })
    .optional(),
});

const ForgeBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  focus: z.string().max(200).optional(),
  instruction: z.string().max(2000).optional(),
});

const ReproduceBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  investigationId: z.string().uuid().optional(),
  script: z.string().min(1).max(4000).refine((value) => value.trim().length > 0, "script is required"),
  image: z.string().max(200).optional(),
  checkout: z.boolean().optional(),
  ref: GitRef.optional(),
});

const VerifyBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  script: z.string().min(1).max(4000).refine((value) => value.trim().length > 0, "script is required"),
  image: z.string().max(200).optional(),
  checkout: z.boolean().optional(),
  ref: GitRef.optional(),
});

const CheckoutBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
});

const InstallBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
});

const RunTestsBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
  // Explicit test command (max 500 chars) for future agent use. When
  // omitted, package.json scripts.test from the clone is used.
  testCommand: z.string().min(1).max(500).optional(),
});

const RegressionBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
  testPath: z.string().max(200).optional(),
  // Caller-provided test file content, or generate:true for a Nemotron
  // draft grounded on the twin. Exactly one of the two is required.
  testContent: z.string().min(1).max(8000).optional(),
  generate: z.boolean().optional(),
  focus: z.string().min(1).max(500).optional(),
  instruction: z.string().max(2000).optional(),
});

const ApplyBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
  // Unified diff to apply in the sandbox workspace (validated for
  // plausibility here, truly validated by git apply over there).
  diff: z.string().min(10).max(20000),
});

const ForgeVerifyBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
  // Caller-provided patch: skips drafting, runs the lifecycle
  // deterministically. Omit to draft via Forge (focus/instruction apply).
  diff: z.string().min(10).max(20000).optional(),
  focus: z.string().max(200).optional(),
  instruction: z.string().max(2000).optional(),
  // Explicit verification command (max 500 chars). Defaults to the repo's
  // own test command via the manager. Never defaulted to echo.
  verificationCommand: z.string().min(1).max(500).optional(),
});

const ForgeStructuredBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  investigationId: z.string().uuid().optional(),
  ref: GitRef.optional(),
  image: z.string().max(200).optional(),
  manager: z.enum(["pnpm", "npm"]).optional(),
  // Required: selects the relevant twin functions for source excerpts and
  // states the behavior the edit must pin down.
  // Carries the complete approved investigation contract, not only a short
  // behavioral summary. The structured edit contract remains unchanged.
  focus: z.string().min(1).max(2000),
  instruction: z.string().max(2000).optional(),
  verificationCommand: z.string().min(1).max(500).optional(),
});

function logInvestigation(event: string, details: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV !== "production") {
    console.info(`[investigate] ${event}`, details);
  }
}

// Rewrite absolute clone-dir paths to repo-relative posix paths so stored
// twins never leak the server's temp directory.
export function toRepoRelative(tmp: string, abs: string): string {
  const rel = path.relative(tmp, abs);
  if (rel === "" || rel.startsWith("..")) return abs;
  return rel.split(path.sep).join("/");
}

interface PersistedSourceFact {
  path: string;
  line: number;
  kind: "source" | "test";
  text: string;
}

// Persist only bounded, contract-shaped source facts. Investigation needs
// assertions and guard/operation evidence, not a repository dump; this also
// keeps arbitrary repository text out of later model prompts. The filter is
// repository-agnostic: generic assertion/guard/duplication language only,
// never demo-domain vocabulary.
export function buildSourceFacts(
  tmp: string,
  twin: { functions: Array<{ path: string }>; tests: Array<{ path: string }> }
): PersistedSourceFact[] {
  const files = new Map<string, "source" | "test">();
  for (const fn of twin.functions) files.set(fn.path, "source");
  for (const test of twin.tests) files.set(test.path, "test");
  const facts: PersistedSourceFact[] = [];
  // A line is retained when it is behavior-bearing: an assertion, guard,
  // throw, call, or a STRUCTURAL ASSIGNMENT. The assignment clause is generic
  // (any `lhs = rhs`, `+=`, `x.y = …`, `??=` … ) and deliberately excludes
  // comparisons (`==`, `===`, `!=`, `>=`, `<=`) and arrows (`=>`). This keeps a
  // real defect assignment such as `total = subtotal` or
  // `order.total = discountedTotal` available to the evidence layer without a
  // domain-specific whitelist.
  const BEHAVIOR_BEARING =
    /(throw\s+new\s+Error|toThrow|rejects\.to|\.has\s*\(|\.add\s*\(|\.push\s*\(|\.set\s*\(|\.save\s*\(|\.delete\s*\(|\bit\s*\(|\bdescribe\s*\(|\btest\s*\(|\bif\s*\(|\bthrow\b|\bexpect\s*\(|error|reject|rejects|duplicate|retry|guard|expire|expired|timeout|invalid|wrong|incorrect|[A-Za-z_$][\w$]*\s*\([^)]*\)|[A-Za-z_$][\w$.]*\s*(?:\+|-|\*|\/|%|\|\||&&|\?\?)?=(?!=|>))/i;
  for (const [absolute, kind] of files) {
    if (facts.length >= 500) break;
    let lines: string[];
    try {
      lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, index) => {
      if (facts.length >= 500 || line.length > 500) return;
      if (!BEHAVIOR_BEARING.test(line)) return;
      // Block lines that access or assign secrets. `\bpassword\b` alone would
      // strip legitimate `resetPassword`/`requestPasswordReset` calls, so the
      // word is only blocked when it assigns a value.
      if (/(process\.env|api[_-]?key|secret|authorization|bearer|\bpassword\b\s*[:=])/i.test(line)) return;
      facts.push({ path: toRepoRelative(tmp, absolute), line: index + 1, kind, text: line.trim() });
    });
  }
  return facts;
}

export const app = new Hono();

// Platform concerns (see runtime.ts): the request's time budget starts here,
// and HUBRIS_API_KEY — when configured — gates everything except /health.
app.use("*", requestBudget());
app.use("*", apiKeyGuard());
// Logs ONE line per function instance saying whether git works in this runtime.
app.use("*", coldStartGitCheck());
// Anonymous public-demo traffic (marked by the web app) is held to the demo
// policy: one repo/branch, owned jobs only, fixed commands, no SHIP, limits.
app.use(
  "*",
  demoGuard({
    loadJobResult: async (id) => {
      const db = getDb();
      if (!db) return undefined;
      const rows = await db.select({ result: schema.jobs.result }).from(schema.jobs).where(eq(schema.jobs.id, id));
      return rows[0] ? rows[0].result : undefined;
    },
  })
);

// Maps a cloneAndArchive failure to a response. A host without git is a runtime
// problem (503, actionable), not a repository problem.
function repoStageFailure(c: Context, error: any) {
  if (error?.message === "git-missing") {
    return c.json({ error: GIT_UNAVAILABLE_MESSAGE, code: "GIT_UNAVAILABLE", status: 503 }, 503);
  }
  const step =
    error?.message === "clone" ? "clone" : error?.message === "ls-files" ? "listing" : "archive";
  return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
}

// GET /api/analyze?repo=owner/repo - Analyze a GitHub repo
app.get("/api/analyze", async (c: Context) => {
  const { repo } = c.req.query();
  if (!repo) {
    return c.json({ error: "repo query parameter is required (format: owner/repo)", status: 400 }, 400);
  }

  // `repo` becomes part of an AUTHENTICATED api.github.com path. Only a plain
  // owner/name is accepted: dot segments ("../user"), extra segments, and
  // encoded separators must never steer the server token to another endpoint.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    return c.json({ error: "repo must be in the form owner/repo", status: 400 }, 400);
  }

  try {
    // Fetch repository metadata from GitHub API
    const githubApiUrl = `https://api.github.com/repos/${ repo }`;
    const headers: Record<string, string> = {
      "User-Agent": "HUBRIS/0.1.0",
    };
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const response = await fetch(githubApiUrl, {
      headers,
    });

    if (!response.ok) {
      const statusCode = response.status;
      const errorBody = await response.text();
      return c.json(
        { error: `GitHub API error: ${statusCode}`, details: errorBody, status: statusCode },
        statusCode as ContentfulStatusCode
      );
    }

    const repoData = await response.json() as {
      name: string;
      full_name: string;
      owner: { login: string };
      description?: string;
      language?: string;
      private: boolean;
      html_url: string;
      stargazers_count: number;
      forks_count: number;
    };

    return c.json({
      repository: {
        id: crypto.randomUUID(),
        name: repoData.name,
        fullName: repoData.full_name,
        owner: repoData.owner.login,
        description: repoData.description,
        language: repoData.language,
        private: repoData.private,
        url: repoData.html_url,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
      },
      analysisStatus: "pending",
      message: "Repository received - analysis would be triggered via Nebius Token Factory sandbox",
    });
  } catch (error: any) {
    console.error("GitHub API error:", error);
    return c.json({ error: error.message || "Failed to analyze repository", status: 500 }, 500);
  }
});

// POST /api/analyze - Clone a public repo and run the CodeTwin analyzer.
// Local stand-in for the Nebius Token Factory sandbox worker: same contract
// (clone -> analyze -> twin summary), minus isolation. Never executes repo code.
app.post("/api/analyze", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = AnalyzeBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "repoUrl is required", status: 400 }, 400);
  }

  const cloneUrl = toSafeCloneUrl(parsed.data.repoUrl);
  if (!cloneUrl) {
    return c.json(
      { error: "Only public https://github.com/owner/repo URLs are accepted.", status: 400 },
      400
    );
  }

  const jobId = crypto.randomUUID();
  const ref = parsed.data.ref;
  const db = getDb();
  if (db) {
    try {
      await db.insert(schema.jobs).values({ id: jobId, repoUrl: cloneUrl, status: "pending" });
    } catch (dbError: any) {
      console.error("Job store error:", dbError?.message);
      return c.json({ error: "Job store unavailable", status: 500 }, 500);
    }
  }
  try {
    const tmp = path.join(os.tmpdir(), `hubris-${jobId}`);
    try {
      await execFileAsync("git", [
        "clone", "--depth", "1",
        ...(ref ? ["--branch", ref] : []),
        cloneUrl, tmp,
      ], {
        timeout: 90000,
      });
const started = Date.now();
      const twin = await analyzeRepository(tmp);
      const sourceFacts = buildSourceFacts(tmp, twin);
      twin.name = cloneUrl.split("/").slice(-2).join("/").replace(/\.git$/, "");
      for (const fn of twin.functions) fn.path = toRepoRelative(tmp, fn.path);
      for (const cls of twin.classes) cls.path = toRepoRelative(tmp, cls.path);
      for (const e of twin.endpoints) e.file = toRepoRelative(tmp, e.file);
      for (const t of twin.tests) {
        t.path = toRepoRelative(tmp, t.path);
        t.file = toRepoRelative(tmp, t.file);
      }
      for (const r of twin.relationships) r.from = toRepoRelative(tmp, r.from);
      // Exact analyzed revision: the commit the clone resolved to. Binds the
      // twin to a concrete source revision for every downstream stage.
      let commitSha: string | null = null;
      try {
        const rev = await execFileAsync("git", ["-C", tmp, "rev-parse", "HEAD"], {
          timeout: 30000,
        });
        const sha = rev.stdout.trim();
        if (/^[a-f0-9]{40}$/.test(sha)) commitSha = sha;
      } catch {
        commitSha = null;
      }
      const payload = {
        jobId,
        ...(ref ? { ref } : {}),
        ...(commitSha ? { commitSha } : {}),
        packageManager: fs.existsSync(path.join(tmp, "pnpm-lock.yaml"))
          ? "pnpm"
          : fs.existsSync(path.join(tmp, "package-lock.json"))
            ? "npm"
            : null,
        scripts:
          packageJsonScripts(tmp),
        repository: {
          id: twin.repositoryId,
          name: twin.name,
          analysisStatus: "complete",
        },
        stats: {
          packages: twin.packages.length,
          functions: twin.functions.length,
          classes: twin.classes.length,
          endpoints: twin.endpoints.length,
          tests: twin.tests.length,
          relationships: twin.relationships.length,
          analysisMs: Date.now() - started,
        },
        sample: {
          functions: twin.functions.slice(0, 10),
          endpoints: twin.endpoints.slice(0, 10),
        },
      };
      // A demo job is owned by the session that created it (see demo.ts).
      const demoSession = demoSessionOf(c);
      if (db) {
        await db
          .update(schema.jobs)
          .set({
            status: "complete",
            result: {
              ...payload,
              ...(typeof demoSession === "string" && demoSession !== "invalid" ? { demoSession } : {}),
              full: {
                functions: twin.functions,
                classes: twin.classes,
                endpoints: twin.endpoints,
                tests: twin.tests,
                relationships: twin.relationships,
                sourceFacts,
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, jobId));
      }
      return c.json(payload);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  } catch (error: any) {
    const gitMissing = isMissingBinary(error);
    console.error("Analyze error:", gitMissing ? "git binary not found" : error?.message);
    const msg = gitMissing
      ? GIT_UNAVAILABLE_MESSAGE
      : error?.killed
        ? "Clone timed out. Repo may be too large for local analysis."
        : error?.message || "Failed to analyze repository";
    if (db) {
      try {
        await db
          .update(schema.jobs)
          .set({ status: "failed", error: msg, updatedAt: new Date() })
          .where(eq(schema.jobs.id, jobId));
      } catch {
        // store unreachable; fall through to error response
      }
    }
    return gitMissing
      ? c.json({ error: msg, code: "GIT_UNAVAILABLE", status: 503 }, 503)
      : c.json({ error: msg, status: 500 }, 500);
  }
});

// GET /api/jobs - List persisted analysis jobs, latest first.
// Query: ?limit= (default 20, max 100), ?repoUrl= (exact clone-URL match)
app.get("/api/jobs", async (c: Context) => {
  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }
  const rawLimit = Number(c.req.query("limit"));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 100);
  const repoUrl = c.req.query("repoUrl");
  // A demo session lists only the jobs it created (demoGuard validated it).
  const session = demoSessionOf(c);
  const owned = typeof session === "string" ? sql`${schema.jobs.result}->>'demoSession' = ${session}` : undefined;
  const filters = [repoUrl ? eq(schema.jobs.repoUrl, repoUrl) : undefined, owned].filter(
    (f): f is NonNullable<typeof f> => f !== undefined
  );
  const base = db.select().from(schema.jobs).$dynamic();
  const rows = await (filters.length > 0 ? base.where(and(...filters)) : base)
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
  return c.json({ jobs: rows });
});

// GET /api/jobs/:id - Fetch a persisted analysis job
app.get("/api/jobs/:id", async (c: Context) => {
  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "Job id is required", status: 400 }, 400);
  }
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  return c.json(job);
});

// POST /api/investigate - Ask the model about a completed analysis job.
// Body: { jobId, question? }. Requires job store + model configuration.
app.post("/api/investigate", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    logInvestigation("invalid-json");
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const rawJobId =
    typeof rawBody === "object" && rawBody !== null && "jobId" in rawBody
      ? (rawBody as { jobId?: unknown }).jobId
      : undefined;
  const rawFocus =
    typeof rawBody === "object" && rawBody !== null && "focus" in rawBody
      ? (rawBody as { focus?: unknown }).focus
      : undefined;
  logInvestigation("request-received", {
    jobId: typeof rawJobId === "string" ? rawJobId : null,
    focusLength: typeof rawFocus === "string" ? rawFocus.length : 0,
  });

  const parsed = InvestigateBody.safeParse(rawBody);
  if (!parsed.success) {
    logInvestigation("validation-failed", { issueCount: parsed.error.issues.length });
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    logInvestigation("job-store-unavailable");
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    logInvestigation("job-not-found", { jobId: parsed.data.jobId });
    return c.json({ error: "Job not found", status: 404 }, 404);
  }
  logInvestigation("job-loaded", {
    jobId: job.id,
    jobStatus: job.status,
    hasResult: job.result !== null,
  });
  const result = job.result as {
    ref?: string;
    repository?: { name?: string };
    stats?: { functions: number; classes: number; endpoints: number; tests: number; relationships: number };
    sample?: { functions?: Array<{ name?: string }>; endpoints?: Array<{ method?: string; path?: string }> };
    full?: {
      functions?: Array<{ name?: string; path?: string; line?: number }>;
      endpoints?: Array<{ method?: string; path?: string; file?: string }>;
      relationships?: Array<{ from?: string; to?: string; type?: string; caller?: string }>;
      sourceFacts?: Array<{ path?: string; line?: number; kind?: "source" | "test"; text?: string }>;
    };
  } | null;
  if (job.status !== "complete" || !result?.stats) {
    logInvestigation("analysis-incomplete", { jobId: job.id, jobStatus: job.status });
    return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
  }

  // Structured investigation mode (Phase INVESTIGATE→FORGE). Pure twin
  // retrieval: no model call, no model configuration required, and no
  // repository writes or execution. The grounded result is persisted as a
  // historical investigation record on the job; the legacy prose mode below
  // is unchanged.
  const focus = parsed.data.focus?.trim();
  if (focus) {
    const full = result.full;
    const tests = (full as { tests?: unknown } | undefined)?.tests;
    logInvestigation("structured-branch", {
      jobId: job.id,
      hasFullTwin: full !== undefined && full !== null,
      functionCount: Array.isArray(full?.functions) ? full.functions.length : 0,
      testCount: Array.isArray(tests) ? tests.length : 0,
      relationshipCount: Array.isArray(full?.relationships) ? full.relationships.length : 0,
    });
    // A structured answer is validated against the persisted prior question of
    // THIS job before anything else runs: stale, unknown, already-answered, or
    // report-changed selections are rejected without touching the model.
    let answerResolution: Extract<ClarificationAnswerResolution, { ok: true }> | null = null;
    if (parsed.data.answer) {
      const priorRuns = (job.result as { investigationRuns?: unknown[] } | null)?.investigationRuns ?? [];
      const resolution = resolveClarificationAnswer(
        priorRuns,
        { priorInvestigationId: parsed.data.priorInvestigationId, answer: parsed.data.answer },
        focus,
        job.id
      );
      if (!resolution.ok) {
        logInvestigation("clarification-rejected", { jobId: job.id, code: resolution.code });
        return c.json(
          { error: resolution.error, state: "STALE_CLARIFICATION", code: resolution.code, status: resolution.status },
          resolution.status
        );
      }
      answerResolution = resolution;
    }
    const agent = await runInvestigationAgent({
      llm: llmConfigFromEnv(),
      selections: answerResolution?.selections,
      askedOptionSets: answerResolution?.askedOptionSets,
      jobId: job.id,
      repository: result.repository?.name ?? job.repoUrl,
      ref: typeof result.ref === "string" ? result.ref : null,
      commitSha:
        typeof (result as { commitSha?: unknown }).commitSha === "string"
          ? (result as { commitSha: string }).commitSha
          : null,
      scripts: (result as { scripts?: Record<string, string> }).scripts,
      packageManager:
        typeof (result as { packageManager?: unknown }).packageManager === "string"
          ? (result as { packageManager: string }).packageManager
          : null,
      report: focus,
      functions: Array.isArray(full?.functions) ? full.functions : [],
      tests: Array.isArray(tests)
        ? (tests as Array<{ name?: string; path?: string; file?: string }>)
        : [],
      relationships: Array.isArray(full?.relationships) ? full.relationships : [],
      sourceFacts: Array.isArray(full?.sourceFacts) ? full.sourceFacts : [],
      clarification:
        parsed.data.clarification?.trim()
          ? {
              priorQuestion: parsed.data.priorQuestion?.trim() ?? "",
              answer: parsed.data.clarification.trim(),
            }
          : undefined,
    });
    const verdict = agent.deterministic;
    const investigationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const record = {
      investigationId,
      jobId: job.id,
      focus,
      ...verdict,
      // Richer state model (spec §7). `status` stays READY|AMBIGUOUS|NO_MATCH
      // for existing gating; `state` distinguishes review-from-answer.
      state: agent.state,
      observedBehavior: agent.observedBehavior,
      expectedBehavior: agent.expectedBehavior,
      modelSummary: agent.modelSummary,
      clarification: agent.clarification,
      blocked: agent.blocked,
      selections: agent.selections,
      askedOptionSets: agent.askedOptionSets,
      answer: answerResolution?.answer ?? null,
      retrievedEvidence: agent.retrievedEvidence,
      relevantScenarios: agent.relevantScenarios,
      relevantSourceFacts: agent.relevantSourceFacts,
      relevantAssertions: agent.relevantAssertions,
      modelUsed: agent.modelUsed,
      createdAt,
      source: {
        jobId: job.id,
        repository: result.repository?.name ?? job.repoUrl,
        ref: typeof result.ref === "string" ? result.ref : null,
        commitSha: typeof (result as { commitSha?: unknown }).commitSha === "string"
          ? (result as { commitSha: string }).commitSha
          : null,
      },
    };
    const prior = (job.result as { investigationRuns?: unknown[] } | null)?.investigationRuns ?? [];
    try {
      await db
        .update(schema.jobs)
        .set({
          result: { ...(job.result as object), investigationRuns: [...prior, record] },
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, job.id));
    } catch (error: any) {
      logInvestigation("persistence-failed", { jobId: job.id, message: error?.message });
      return c.json({ error: "Investigation could not be persisted", status: 503 }, 503);
    }
    logInvestigation("structured-response", {
      jobId: job.id,
      status: verdict.status,
      state: agent.state,
      investigationId,
    });
    return c.json({
      jobId: job.id,
      ...verdict,
      investigationId,
      createdAt,
      state: agent.state,
      observedBehavior: agent.observedBehavior,
      expectedBehavior: agent.expectedBehavior,
      modelSummary: agent.modelSummary,
      clarification: agent.clarification,
      blocked: agent.blocked,
      selections: agent.selections,
      askedOptionSets: agent.askedOptionSets,
      answer: answerResolution?.answer ?? null,
      retrievedEvidence: agent.retrievedEvidence,
      relevantScenarios: agent.relevantScenarios,
      relevantSourceFacts: agent.relevantSourceFacts,
      relevantAssertions: agent.relevantAssertions,
      modelUsed: agent.modelUsed,
    });
  }

  const llm = llmConfigFromEnv();
  if (!llm) {
    return c.json({ error: "Model not configured", status: 503 }, 503);
  }

  const functions: Array<{ name?: string; path?: string; line?: number }> = (
    result.full?.functions ?? result.sample?.functions ?? []
  ).map((f) => f);
  const endpoints = result.full?.endpoints ?? result.sample?.endpoints ?? [];
  const relationships = result.full?.relationships ?? [];
  const handlers = new Map<string, string>();
  for (const r of relationships) {
    if (r.caller?.startsWith("endpoint:") && r.to) handlers.set(r.caller, r.to);
  }
  const prompt = buildInvestigatePrompt(
    {
      repoName: result.repository?.name ?? job.repoUrl,
      stats: result.stats,
      functionNames: functions.map((f) => f.name ?? "").filter(Boolean),
      functionDetails: functions.map((f) =>
        `${f.name ?? "(anonymous)"} — ${f.path ?? "(unknown)"}${f.line ? `:${f.line}` : ""}`
      ),
      routes: endpoints.map((e) => {
        const label = `${e.method ?? ""} ${e.path ?? ""}`.trim();
        const handler = handlers.get(`endpoint:${label}`);
        return handler ? `${label} → ${handler}` : label;
      }).filter(Boolean),
      endpoints: endpoints.map((e) => `${e.method ?? ""} ${e.path ?? ""}`.trim()).filter(Boolean),
    },
    parsed.data.question
  );

  try {
    const answer = await chatComplete(
      llm,
      [
        { role: "system", content: INVESTIGATE_SYSTEM },
        { role: "user", content: prompt },
      ],
      { signal: budgetSignal(60000) }
    );
    return c.json({ jobId: job.id, answer });
  } catch (error: any) {
    console.error("Investigate error:", error?.message);
    return c.json({ error: "Model request failed", status: 502 }, 502);
  }
});

// POST /api/forge - Propose a minimal patch + regression test for a completed job.
// Body: { jobId, focus?, instruction? }. Proposals are UNVERIFIED until the
// sandbox phase lands; the response says so explicitly.
app.post("/api/forge", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = ForgeBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }
  const result = job.result as {
    repository?: { name?: string };
    stats?: { functions: number; classes: number; endpoints: number; tests: number; relationships: number };
    full?: {
      functions?: Array<{ name?: string; path?: string; line?: number }>;
      endpoints?: Array<{ method?: string; path?: string }>;
      relationships?: Array<{ from?: string; to?: string; type?: string }>;
    };
  } | null;
  if (job.status !== "complete" || !result?.stats) {
    return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
  }

  const llm = llmConfigFromEnv();
  if (!llm) {
    return c.json({ error: "Model not configured", status: 503 }, 503);
  }

  const forgeCtx = getForgeContext(
    { repoUrl: job.repoUrl, status: job.status, result },
    parsed.data.focus,
    parsed.data.instruction
  );
  if (!forgeCtx) {
    return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
  }
  const prompt = buildForgePrompt(forgeCtx);

  try {
    const suggestion = await chatComplete(
      llm,
      [
        { role: "system", content: FORGE_SYSTEM },
        { role: "user", content: prompt },
      ],
      { maxTokens: forgeMaxTokens(), signal: budgetSignal(90000) }
    );
    return c.json({
      jobId: job.id,
      suggestion,
      verified: false,
      note: "Proposal only — nothing was applied. Sandbox verification pending.",
    });
  } catch (error: any) {
    console.error(
      "Forge error:",
      error instanceof ModelError ? error.kind : "unknown",
      error?.message,
      // Safe metadata only (counts/keys/flags, never prompt or body text).
      error instanceof ModelError && error.detail
        ? `meta=${JSON.stringify(error.detail)}`
        : ""
    );
    return c.json({ error: "Model request failed", status: 502 }, 502);
  }
});

// POST /api/reproduce - Stage the analyzed repository, provision the
// detected package manager, install dependencies, then run the repro script
// in a disposable sandbox. Evidence records whether the reported failure was
// actually reproduced.
// Body: { jobId, script, image?, ref? }. The script runs from the staged
// repo root with the detected manager available (pnpm/npm), after a
// --ignore-scripts locked install. A failing repro is evidence of the bug
// (REPRODUCED), not an infrastructure failure.
app.post("/api/reproduce", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = ReproduceBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId and script are required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const investigation = parsed.data.investigationId
    ? readyInvestigation(job.result, parsed.data.investigationId)
    : null;
  if (parsed.data.investigationId && !investigation) {
    return c.json(
      { error: "The requested READY investigation is not attached to this job.", status: 400 },
      400
    );
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  // Revision consistency: an explicit caller ref wins (same allow-list as
  // analysis); otherwise the job's persisted analyzed ref is authoritative.
  const jobRef = resolveJobRef(job.result);
  const analyzedCommitSha = resolveJobCommitSha(job.result);
  const ref = parsed.data.ref ?? jobRef ?? undefined;
  const refSource = parsed.data.ref
    ? ("requested" as const)
    : jobRef
      ? ("job" as const)
      : ("default" as const);

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const image = parsed.data.image ?? "tag:node:20-slim";
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-reproduce-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp, analyzedCommitSha ?? undefined);
    } catch (error: any) {
      if (error?.message === "revision-mismatch") {
        return c.json({ error: "Staged source does not match the analyzed commit.", status: 409 }, 409);
      }
      return repoStageFailure(c, error);
    }
    const { tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(staged.tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    const source = {
      analysisRef: jobRef,
      ref: ref ?? null,
      refSource,
      analysisCommitSha: analyzedCommitSha,
      executionCommitSha: staged.commitSha,
      commitSha: staged.commitSha,
    };
    if (analyzedCommitSha && staged.commitSha !== analyzedCommitSha) {
      return c.json({ error: "Staged source does not match the analyzed commit.", status: 409 }, 409);
    }

    // Package-manager detection reuses the install pipeline's shared logic.
    // Unsupported lockfiles fail closed as SETUP_FAILED instead of guessing.
    const manager = detectManager(tracked);
    if (!manager) {
      const evidence = {
        script: parsed.data.script,
        requestedCommand: parsed.data.script,
        command: parsed.data.script,
        executedCommand: null,
        setup: { status: "FAILED", reason: "No supported package manager detected." },
        execution: { status: "NOT_STARTED", exitCode: null },
        investigationId: parsed.data.investigationId ?? null,
        source,
        outcome: "SETUP_FAILED" as const,
        reason: "No supported package manager detected (pnpm-lock.yaml or package-lock.json at repository root).",
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        packageManager: null,
        installStatus: "not-run",
        image,
        at: new Date().toISOString(),
      };
      const prior = (job.result as { reproductions?: unknown[] } | null)?.reproductions ?? [];
      await db
        .update(schema.jobs)
        .set({
          result: { ...(job.result as object), reproductions: [...prior, evidence] },
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, job.id));
      return c.json({ jobId: job.id, evidence });
    }

    let tarUpload;
    try {
      tarUpload = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
    } catch (error: any) {
      console.error("Reproduce upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (tarUpload.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

     const executedCommand = buildReproScript(manager, excluded, parsed.data.script);
     const startedAt = Date.now();
     let result;
     try {
       result = await runCommand(sandbox, {
         command: executedCommand,
        image,
        files: { [CHECKOUT_UPLOAD_PATH]: { uuid: tarUpload.uuid } },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Reproduce run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }

     // The failure must demonstrate the INVESTIGATED behavior: when the run is
     // bound to a READY investigation, only a failure of its named scenario
     // counts as a reproduction.
     const investigatedPlan = (investigation?.plan ?? null) as {
       reproduction?: { scenario?: unknown; testFile?: unknown };
     } | null;
     const expectation = investigatedPlan?.reproduction
       ? {
           scenario:
             typeof investigatedPlan.reproduction.scenario === "string" ? investigatedPlan.reproduction.scenario : null,
           testFile:
             typeof investigatedPlan.reproduction.testFile === "string" ? investigatedPlan.reproduction.testFile : null,
         }
       : null;
     const classification = classifyReproduction(
       {
         exitCode: result.exitCode,
         timedOut: result.timedOut,
         stdout: result.stdout,
         stderr: result.stderr,
       },
       expectation
     );
     const evidence = {
       script: parsed.data.script,
       requestedCommand: parsed.data.script,
       command: executedCommand,
       executedCommand,
       setup: {
         status: result.stdout.includes(REPRO_BEGIN_MARKER) ? "SUCCEEDED" : "FAILED",
         packageManager: manager,
       },
       execution: {
         status: result.stdout.includes(REPRO_BEGIN_MARKER)
           ? result.timedOut
             ? "TIMEOUT"
             : result.exitCode === 127 || /(command )?not found/i.test(result.stderr)
               ? "COMMAND_NOT_FOUND"
               : "COMPLETED"
           : "NOT_STARTED",
         command: parsed.data.script,
         exitCode: result.stdout.includes(REPRO_BEGIN_MARKER) ? result.exitCode : null,
       },
       durationMs: Date.now() - startedAt,
       investigationId: parsed.data.investigationId ?? null,
       outcome: classification.outcome,
      demonstrated: classification.demonstrated ?? null,
      reason: classification.reason,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      packageManager: manager,
      installStatus: result.stdout.includes(REPRO_BEGIN_MARKER) ? "installed" : "failed",
      image,
       source,
      at: new Date().toISOString(),
    };
    const prior = (job.result as { reproductions?: unknown[] } | null)?.reproductions ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), reproductions: [...prior, evidence] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, evidence });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/verify - Run a verification check in a disposable sandbox and
// record pass/fail on the job. Unlike reproduce (which captures failure
// evidence), verify asserts a check exits 0.
// Body: { jobId, script, image?, checkout?, ref? }. checkout:true clones the
// job's repoUrl first (same contract as reproduce); default false keeps
// checks self-contained.
app.post("/api/verify", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = VerifyBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId and script are required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const checkout = parsed.data.checkout ?? true;
  const requestedCommand = parsed.data.script.trim();
  const analysisRef = resolveJobRef(job.result);
  const analysisCommitSha = resolveJobCommitSha(job.result);
  const ref = parsed.data.ref ?? analysisRef ?? undefined;
  const image = parsed.data.image ?? "tag:node:20-slim";
  const persist = async (verification: Record<string, unknown>) => {
    const prior = (job.result as { verifications?: unknown[] } | null)?.verifications ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), verifications: [...prior, verification] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
  };
  const baseEvidence = {
    requestedCommand,
    script: requestedCommand,
    checkout,
    image,
    analysisRef,
    analysisCommitSha,
    at: new Date().toISOString(),
  };

  let tmp: string | null = null;
  try {
    let command = requestedCommand;
    let executionCommitSha: string | null = null;
    let setupStatus: "NOT_REQUESTED" | "SUCCEEDED" | "FAILED" = "NOT_REQUESTED";
    let setupReason: string | null = null;
    if (checkout) {
      const cloneUrl = toSafeCloneUrl(job.repoUrl);
      if (!cloneUrl) {
        return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
      }
      const checkoutLimits = limitsFromEnv();
      tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-verify-"));
      let staged;
      try {
        staged = await cloneAndArchive(cloneUrl, ref, tmp, analysisCommitSha ?? undefined);
      } catch (error: any) {
        if (error?.message === "revision-mismatch") {
          const verification = {
            ...baseEvidence,
            actualCommand: null,
            setup: { status: "FAILED", reason: "Staged source does not match the analyzed commit." },
            execution: { status: "NOT_STARTED", command: null, exitCode: null },
            result: "SOURCE_MISMATCH",
            passed: false,
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            executionCommitSha: null,
          };
          await persist(verification);
          return c.json({ jobId: job.id, verification }, 409);
        }
        const verification = {
          ...baseEvidence,
          actualCommand: null,
          setup: { status: "FAILED", reason: "Repository staging failed." },
          execution: { status: "NOT_STARTED", command: null, exitCode: null },
          result: "SETUP_FAILED",
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          executionCommitSha: null,
        };
        await persist(verification);
        return c.json({ jobId: job.id, verification }, 500);
      }
      executionCommitSha = staged.commitSha;
      if (analysisCommitSha && executionCommitSha !== analysisCommitSha) {
        const verification = {
          ...baseEvidence,
          actualCommand: null,
          setup: { status: "FAILED", reason: "Staged source does not match the analyzed commit." },
          execution: { status: "NOT_STARTED", command: null, exitCode: null },
          result: "SOURCE_MISMATCH",
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          executionCommitSha,
        };
        await persist(verification);
        return c.json({ jobId: job.id, verification }, 409);
      }
      const tracked = staged.tracked;
      const excluded = tracked.filter(isTransferExcluded);
      if (tracked.length > checkoutLimits.maxFiles) {
        return c.json({ error: "Repository exceeds transfer limits", status: 413 }, 413);
      }
      const manager = detectManager(tracked);
      if (!manager) {
        const verification = {
          ...baseEvidence,
          actualCommand: null,
          setup: { status: "FAILED", reason: "No supported package manager detected." },
          execution: { status: "NOT_STARTED", command: null, exitCode: null },
          result: "SETUP_FAILED",
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          executionCommitSha,
        };
        await persist(verification);
        return c.json({ jobId: job.id, verification });
      }
      const tarBytes = await fs.promises.readFile(staged.tarPath);
      const tarUpload = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
      const localSha = createHash("sha256").update(tarBytes).digest("hex");
      if (tarUpload.sha256 !== localSha) {
        return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
      }
      command = buildVerifyScript(manager, excluded, requestedCommand);
      setupStatus = "SUCCEEDED";
      setupReason = `Installed dependencies with ${manager}.`;
      const limits = executionLimitsFromEnv();
      const startedAt = Date.now();
      const result = await runCommand(sandbox, {
        command,
        image,
        files: { [CHECKOUT_UPLOAD_PATH]: { uuid: tarUpload.uuid } },
        shell: true,
        disposable: true,
        timeout: limits.commandTimeoutS,
        truncateOutputAt: limits.maxOutputBytes,
        waitMs: limits.waitMs,
      });
      const classification = classifyVerification({
        setupRequired: true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const verification = {
        ...baseEvidence,
        actualCommand: command,
        setup: {
          status: classification.setupStatus,
          reason: classification.setupStatus === "SUCCEEDED" ? setupReason : "Dependency installation or checkout failed.",
        },
        execution: {
          status: classification.executionStatus,
          command: requestedCommand,
          exitCode: classification.exitCode,
        },
        result: classification.result,
        passed: classification.passed,
        exitCode: classification.exitCode,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 4000),
        timedOut: result.timedOut,
        executionCommitSha,
        durationMs: Date.now() - startedAt,
      };
      await persist(verification);
      return c.json({ jobId: job.id, verification });
    }

    const limits = executionLimitsFromEnv();
    const startedAt = Date.now();
    const result = await runCommand(sandbox, {
      command,
      image,
      shell: true,
      disposable: true,
      timeout: limits.commandTimeoutS,
      truncateOutputAt: limits.maxOutputBytes,
      waitMs: limits.waitMs,
    });
    const classification = classifyVerification({
      setupRequired: false,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    const verification = {
      ...baseEvidence,
      actualCommand: command,
      setup: { status: classification.setupStatus, reason: setupReason },
      execution: {
        status: classification.executionStatus,
        command: requestedCommand,
        exitCode: classification.exitCode,
      },
      result: classification.result,
      passed: classification.passed,
      exitCode: classification.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      timedOut: result.timedOut,
      executionCommitSha,
      durationMs: Date.now() - startedAt,
    };
    await persist(verification);
    return c.json({ jobId: job.id, verification });
  } catch (error: any) {
    console.error("Verify error:", error?.message);
    const verification = {
      ...baseEvidence,
      actualCommand: null,
      setup: { status: "FAILED", reason: "Sandbox setup did not complete." },
      execution: { status: "NOT_STARTED", command: null, exitCode: null },
      result: "SETUP_FAILED",
      passed: false,
      exitCode: null,
      stdout: "",
      stderr: error?.message ? String(error.message).slice(0, 4000) : "",
      timedOut: false,
      executionCommitSha: null,
    };
    await persist(verification).catch(() => undefined);
    return c.json({ error: "Sandbox setup failed", verification, status: 502 }, 502);
  } finally {
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/checkout - Transfer a job's repository into a sandbox workspace.
// Body: { jobId, ref?, image? }. Clones the job's public repoUrl locally
// (never executes it), archives tracked files, uploads the tarball, and
// spawns a disposable sandbox that extracts it to /tmp/hubris-repo and
// reports a bounded manifest. Transfer integrity is verified twice:
// tarball sha256 (local vs server echo) and workspace file count
// (expected vs remote). Evidence lands on job.result.checkouts[].
// Install/test execution is Phase D — this endpoint only places + verifies.
app.post("/api/checkout", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = CheckoutBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-checkout-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    let uploaded;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
    } catch (error: any) {
      console.error("Checkout upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildCheckoutScript(excluded),
        image: parsed.data.image ?? "tag:busybox:latest",
        files: { [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid } },
        shell: true,
        disposable: true,
        timeout: execLimits.commandTimeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: execLimits.waitMs,
      });
    } catch (error: any) {
      console.error("Checkout run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }

    const { count, excerpt } = parseCheckoutListing(result.stdout);
    const verified =
      result.exitCode === 0 && !result.timedOut && count === expected;
    const entry = {
      repoUrl: job.repoUrl,
      ...(ref ? { ref } : {}),
      image: parsed.data.image ?? "tag:busybox:latest",
      workspace: REPO_WORKDIR,
      files: expected,
      excluded,
      bytes: tarBytes.length,
      sha256: localSha,
      uploadSha256: uploaded.sha256,
      remoteCount: count,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      verified,
      listing: excerpt,
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { checkouts?: unknown[] } | null)?.checkouts ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), checkouts: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, checkout: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/install - Install a job's repository dependencies in a sandbox.
// Body: { jobId, ref?, image?, manager? }. Same clone/archive/upload staging
// as checkout, then runs the package manager with --ignore-scripts (never
// lifecycle scripts in Phase D) on a node-capable image (default
// tag:node:20-slim). Manager auto-detects from root lockfiles unless given.
// Evidence lands on job.result.installs[]. Test execution is Phase E.
app.post("/api/install", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = InstallBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = installTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-install-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    let uploaded;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
    } catch (error: any) {
      console.error("Install upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    const detected = detectManager(tracked);
    const manager: PackageManager = parsed.data.manager ?? detected ?? "pnpm";
    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildInstallScript(manager, excluded),
        image: parsed.data.image ?? "tag:node:20-slim",
        files: { [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid } },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Install run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }

    const ok = result.exitCode === 0 && !result.timedOut;
    const entry = {
      repoUrl: job.repoUrl,
      ...(ref ? { ref } : {}),
      manager,
      managerSource: parsed.data.manager ? "requested" : detected ? "detected" : "default",
      image: parsed.data.image ?? "tag:node:20-slim",
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ok,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { installs?: unknown[] } | null)?.installs ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), installs: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, install: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/run-tests - Run a job's repository test suite in a sandbox.
// Body: { jobId, ref?, image?, manager?, testCommand? }. Stages the repo
// (clone/archive/upload, same guards as checkout), installs with
// --ignore-scripts, then runs the repo's own test command: explicit
// testCommand wins, otherwise package.json scripts.test from the clone
// invoked via the manager. No test script anywhere -> 400, never a fake.
// PASS = exit 0 without timeout; anything else is FAIL. The TEST_BEGIN
// marker attributes failure to the install vs test phase without scoring.
// Evidence lands on job.result.testRuns[].
app.post("/api/run-tests", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = RunTestsBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-testrun-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { src, tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    let uploaded;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
    } catch (error: any) {
      console.error("Test-run upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    const detected = detectManager(tracked);
    const manager: PackageManager = parsed.data.manager ?? detected ?? "pnpm";
    const requested = parsed.data.testCommand;
    let declared: string | null = null;
    if (!requested) {
      declared = await readPackageTestScript(src);
      if (!declared) {
        return c.json({ error: "Repository has no test script", status: 400 }, 400);
      }
    }
    const invoke = requested ?? `${manager} test`;
    const commandSource = requested ? "requested" : "detected";

    const started = Date.now();
    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildTestScript(manager, excluded, invoke),
        image: parsed.data.image ?? "tag:node:20-slim",
        files: { [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid } },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Test-run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }
    const durationMs = Date.now() - started;

    const phase = result.stdout.includes(TEST_BEGIN_MARKER) ? "test" : "install";
    const passed = result.exitCode === 0 && !result.timedOut;
    const entry = {
      repoUrl: job.repoUrl,
      ...(ref ? { ref } : {}),
      manager,
      testCommand: invoke,
      ...(declared ? { declaredTest: declared } : {}),
      commandSource,
      phase,
      image: parsed.data.image ?? "tag:node:20-slim",
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      passed,
      durationMs,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { testRuns?: unknown[] } | null)?.testRuns ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), testRuns: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, testRun: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/regression - Write a regression test into a sandbox workspace
// and execute the suite against it.
// Body: { jobId, ref?, image?, manager?, testPath?, testContent XOR
// generate, focus?, instruction? }. testContent is caller-provided test
// file source; generate:true drafts it with Nemotron grounded on the job's
// twin (focus required, the behavior to pin down). The file travels as a
// second upload, is copied into the workspace after extraction, then the
// suite runs (same install + TEST_BEGIN discipline as run-tests).
// PASS = exit 0 without timeout. Evidence on job.result.regressions[].
app.post("/api/regression", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = RegressionBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }
  const hasContent = parsed.data.testContent !== undefined;
  const wantGenerate = parsed.data.generate ?? false;
  if (hasContent === wantGenerate) {
    return c.json(
      { error: "Provide exactly one of testContent or generate", status: 400 },
      400
    );
  }
  if (wantGenerate && !parsed.data.focus?.trim()) {
    return c.json({ error: "focus is required when generating", status: 400 }, 400);
  }
  const testPath = parsed.data.testPath ?? DEFAULT_REGRESSION_TEST_PATH;
  if (!isSafeTestPath(testPath)) {
    return c.json({ error: "Invalid testPath", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  // Draft the test before touching the sandbox so model failures never
  // spend sandbox ops.
  let testContent = parsed.data.testContent;
  let generated = false;
  if (wantGenerate) {
    const result = job.result as {
      repository?: { name?: string };
      stats?: { functions: number; classes: number; endpoints: number; tests: number; relationships: number };
      full?: {
        functions?: Array<{ name?: string; path?: string; line?: number }>;
      };
    } | null;
    if (job.status !== "complete" || !result?.stats || !result.full?.functions) {
      return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
    }
    const llm = llmConfigFromEnv();
    if (!llm) {
      return c.json({ error: "Model not configured", status: 503 }, 503);
    }
    const prompt = buildRegressionPrompt({
      repoName: result.repository?.name ?? job.repoUrl,
      stats: result.stats,
      functions: result.full.functions.map((f) => ({
        name: f.name ?? "(anonymous)",
        file: f.path ?? "(unknown)",
        line: f.line ?? 1,
      })),
      focus: parsed.data.focus!,
      instruction: parsed.data.instruction,
    });
    let draft: string;
    try {
      draft = await chatComplete(
        llm,
        [
          { role: "system", content: REGRESSION_SYSTEM },
          { role: "user", content: prompt },
        ],
        { maxTokens: forgeMaxTokens(), signal: budgetSignal(90000) }
      );
    } catch (error: any) {
      console.error("Regression draft error:", error?.message);
      return c.json({ error: "Model request failed", status: 502 }, 502);
    }
    const stripped = stripCodeFences(draft);
    if (!stripped) {
      return c.json({ error: "Model returned an empty test", status: 502 }, 502);
    }
    if (stripped.length > 8000) {
      return c.json({ error: "Generated test exceeds size limits", status: 502 }, 502);
    }
    testContent = stripped;
    generated = true;
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-regression-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    let uploaded;
    let testUpload;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
      testUpload = await uploadFile(sandbox, new TextEncoder().encode(testContent!), {
        timeoutMs: 60000,
      });
    } catch (error: any) {
      console.error("Regression upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    const detected = detectManager(tracked);
    const manager: PackageManager = parsed.data.manager ?? detected ?? "pnpm";
    const started = Date.now();
    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildRegressionScript(manager, excluded, testPath),
        image: parsed.data.image ?? "tag:node:20-slim",
        files: {
          [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid },
          [REGRESSION_STAGING_PATH]: { uuid: testUpload.uuid },
        },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Regression run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }
    const durationMs = Date.now() - started;

    const phase = result.stdout.includes(TEST_BEGIN_MARKER) ? "test" : "install";
    const passed = result.exitCode === 0 && !result.timedOut;
    const entry = {
      repoUrl: job.repoUrl,
      ...(ref ? { ref } : {}),
      manager,
      testCommand: `${manager} test`,
      testPath,
      testBytes: new TextEncoder().encode(testContent!).length,
      generated,
      ...(generated && parsed.data.focus ? { focus: parsed.data.focus } : {}),
      phase,
      image: parsed.data.image ?? "tag:node:20-slim",
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      passed,
      durationMs,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { regressions?: unknown[] } | null)?.regressions ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), regressions: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, regression: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/apply - Apply a unified diff in a sandbox workspace and run
// the suite against it.
// Body: { jobId, diff, ref?, image?, manager? }. Stages the repo
// (clone/archive/upload, same guards), uploads the diff as a second file,
// extracts, `git apply`s it, installs with --ignore-scripts, and runs the
// repo's own tests. applied = the patch went on (PATCH_OK seen);
// passed = exit 0 without timeout (tests green WITH the patch).
// The real repository is never modified. Evidence on job.result.applies[].
app.post("/api/apply", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = ApplyBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId and diff are required", status: 400 }, 400);
  }
  if (!isPlausibleDiff(parsed.data.diff)) {
    return c.json({ error: "diff is not a plausible unified diff", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-apply-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    let uploaded;
    let diffUpload;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
      diffUpload = await uploadFile(sandbox, new TextEncoder().encode(parsed.data.diff), {
        timeoutMs: 60000,
      });
    } catch (error: any) {
      console.error("Apply upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    const detected = detectManager(tracked);
    const manager: PackageManager = parsed.data.manager ?? detected ?? "pnpm";
    const started = Date.now();
    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildApplyScript(manager, excluded),
        image: parsed.data.image ?? "tag:node:20-slim",
        files: {
          [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid },
          [DIFF_STAGING_PATH]: { uuid: diffUpload.uuid },
        },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Apply run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }
    const durationMs = Date.now() - started;

    const applied = result.stdout.includes(PATCH_OK_MARKER);
    const phase = !applied
      ? "patch"
      : result.stdout.includes(TEST_BEGIN_MARKER)
        ? "test"
        : "install";
    const passed = result.exitCode === 0 && !result.timedOut;
    const entry = {
      repoUrl: job.repoUrl,
      ...(ref ? { ref } : {}),
      manager,
      testCommand: `${manager} test`,
      diffBytes: new TextEncoder().encode(parsed.data.diff).length,
      diffSha256: createHash("sha256").update(parsed.data.diff).digest("hex"),
      applied,
      phase,
      image: parsed.data.image ?? "tag:node:20-slim",
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      passed,
      durationMs,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { applies?: unknown[] } | null)?.applies ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), applies: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, apply: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// Persist a terminal forge-run that never reached the full run (failed
// validation twice, or an unparsable redraft). Verification is null by
// construction: nothing executed, so nothing could pass.
async function persistForgeRun(
  c: Context,
  db: NonNullable<ReturnType<typeof getDb>>,
  job: { id: string; result: unknown },
  input: {
    runId: string;
    startedAt: string;
    history: Array<{ state: string; at: string }>;
    status: string;
    attempts: unknown[];
    diff: string;
    source: string;
  }
) {
  const entry = {
    id: input.runId,
    status: input.status,
    history: [...input.history, { state: input.status, at: new Date().toISOString() }],
    generationAttempts: input.attempts,
    patch: {
      source: input.source,
      diffSha256: createHash("sha256").update(input.diff).digest("hex"),
      diffBytes: new TextEncoder().encode(input.diff).length,
    },
    apply: { applied: false },
    verification: null,
    durationMs: null,
    verified: false,
    stdout: "",
    stderr: "",
    at: new Date().toISOString(),
  };
  const prior = (job.result as { forgeRuns?: unknown[] } | null)?.forgeRuns ?? [];
  await db
    .update(schema.jobs)
    .set({
      result: { ...(job.result as object), forgeRuns: [...prior, entry] },
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, job.id));
  return c.json({ jobId: job.id, forgeRun: entry });
}

// POST /api/forge-verify - One-call Forge → Apply → Verify lifecycle.
// Body: { jobId, diff?, focus?, instruction?, ref?, image?, manager?,
// verificationCommand? }. Without diff, drafts a patch via Forge from the
// job's twin (focus/instruction ground it); with diff, that patch runs
// deterministically. Then: VALIDATE the patch with `git apply --check` in
// a lean disposable run; a failed check earns exactly ONE model redraft
// (original task + bounded git error, same diff contract), validated again.
// Only a validated patch reaches the full apply → install → verification
// run (explicit command wins, else the repo's own test command; absent
// command is a 400, never an echo).
// States: PROPOSED → PATCH_VALIDATING → [PATCH_REDRAFTING →
// PATCH_VALIDATING] → APPLYING → APPLIED → VERIFYING → VERIFIED, with
// APPLY_FAILED / FAILED / TIMEOUT terminals. VERIFIED requires actual
// exit 0; exit≠0 is FAILED, timeout is TIMEOUT. Evidence (attempt records
// plus the full state trail) lands on job.result.forgeRuns[].
app.post("/api/forge-verify", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = ForgeVerifyBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId is required", status: 400 }, 400);
  }
  if (parsed.data.diff !== undefined && !isPlausibleDiff(parsed.data.diff)) {
    return c.json({ error: "diff is not a plausible unified diff", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  // Capture the narrowed config for closures below (narrowing does not
  // propagate into nested function bodies).
  const sb = sandbox;

  // Draft the patch before spending sandbox ops. Caller diffs skip this.
  let diff = parsed.data.diff;
  let patchSource: "provided" | "forge" = "provided";
  if (diff === undefined) {
    const forgeCtx = getForgeContext(
      {
        repoUrl: job.repoUrl,
        status: job.status,
        result: job.result as TwinJobLike["result"],
      },
      parsed.data.focus,
      parsed.data.instruction
    );
    if (!forgeCtx) {
      return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
    }
    const llm = llmConfigFromEnv();
    if (!llm) {
      return c.json({ error: "Model not configured", status: 503 }, 503);
    }
    let suggestion: string;
    try {
      suggestion = await chatComplete(
        llm,
        [
          { role: "system", content: FORGE_SYSTEM },
          { role: "user", content: buildForgePrompt(forgeCtx) },
        ],
        { maxTokens: forgeMaxTokens(), signal: budgetSignal(90000) }
      );
    } catch (error: any) {
      console.error("Forge-verify draft error:", error instanceof ModelError ? error.kind : "unknown", error?.message);
      return c.json({ error: "Model request failed", status: 502 }, 502);
    }
    const extracted = extractForgePatch(suggestion);
    if (!extracted || !isPlausibleDiff(extracted)) {
      // Diagnostic evidence only: bounded, scrubbed, marked rejected. The
      // 400 stands even if this write fails; no forgeRuns[] entry because
      // nothing executed.
      try {
        const prior =
          (job.result as { draftRejections?: unknown[] } | null)?.draftRejections ?? [];
        await db
          .update(schema.jobs)
          .set({
            result: {
              ...(job.result as object),
              draftRejections: [...prior, { ...buildRejectedDraftPreview(suggestion), at: new Date().toISOString() }],
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.jobs.id, job.id));
      } catch {
        // best-effort; rejection stands regardless
      }
      return c.json({ error: "Forge produced no usable patch", status: 400 }, 400);
    }
    diff = extracted;
    patchSource = "forge";
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-forge-verify-"));
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      return repoStageFailure(c, error);
    }
    const { src, tarPath, tracked } = staged;
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    const image = parsed.data.image ?? "tag:node:20-slim";
    const filesBase = {} as Record<string, { uuid: string }>;
    let tarUpload;
    try {
      tarUpload = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
    } catch (error: any) {
      console.error("Forge-verify upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", status: 502 }, 502);
    }
    if (tarUpload.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }
    filesBase[CHECKOUT_UPLOAD_PATH] = { uuid: tarUpload.uuid };

    const detected = detectManager(tracked);
    const manager: PackageManager = parsed.data.manager ?? detected ?? "pnpm";
    const requested = parsed.data.verificationCommand;
    let verifyInvoke = requested;
    let commandSource = "requested";
    if (!verifyInvoke) {
      const declared = await readPackageTestScript(src);
      if (!declared) {
        return c.json({ error: "Repository has no test command", status: 400 }, 400);
      }
      verifyInvoke = `${manager} test`;
      commandSource = "detected";
    }

    // Lean validation run: extract + `git apply --check` only. Decides
    // whether the patch ever reaches the full run. Transport throws map
    // to 502 (precedent); in-band failures feed the redraft decision.
    async function validatePatch(patchDiff: string) {
      const up = await uploadFile(sb, new TextEncoder().encode(patchDiff), {
        timeoutMs: 60000,
      });
      const res = await runCommand(sb, {
        command: buildApplyCheckScript(excluded),
        image,
        files: { ...filesBase, [DIFF_STAGING_PATH]: { uuid: up.uuid } },
        shell: true,
        disposable: true,
        timeout: execLimits.commandTimeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: execLimits.waitMs,
      });
      return parseApplyCheckResult(res);
    }

    const history: Array<{ state: string; at: string }> = [
      { state: "PROPOSED", at: startedAt },
      { state: "PATCH_VALIDATING", at: new Date().toISOString() },
    ];
    const attempts = [
      toAttemptRecord({
        attempt: 1,
        source: patchSource,
        diff,
        parseAccepted: true,
        applyCheckPassed: null,
      }),
    ];

    let activeDiff = diff!;
    let activeSource: "provided" | "forge" | "forge-redraft" = patchSource;
    let check: { passed: boolean; timedOut: boolean; error: string };
    try {
      check = await validatePatch(activeDiff);
    } catch (error: any) {
      console.error("Forge-verify validation error:", error?.message);
      return c.json({ error: "Sandbox validation failed", status: 502 }, 502);
    }
    attempts[0] = {
      ...attempts[0],
      applyCheckPassed: check.passed,
    } as typeof attempts[0];

    // Exactly ONE redraft on validation failure. Same diff contract, plus
    // the bounded git error. A second failure ends the lifecycle.
    if (!check.passed) {
      history.push({ state: "PATCH_REDRAFTING", at: new Date().toISOString() });
      const llm2 = llmConfigFromEnv();
      if (!llm2) {
        return c.json({ error: "Model not configured", status: 503 }, 503);
      }
      let redraft: string | null = null;
      try {
        const suggestion2 = await chatComplete(
          llm2,
          [
            { role: "system", content: REDRAFT_SYSTEM },
            {
              role: "user",
              content: buildRedraftPrompt({
                originalDiff: activeDiff,
                gitError: check.error,
                focus: parsed.data.focus,
                instruction: parsed.data.instruction,
              }),
            },
          ],
          { maxTokens: forgeMaxTokens(), signal: budgetSignal(90000) }
        );
        const extracted2 = extractForgePatch(suggestion2);
        redraft = extracted2 && isPlausibleDiff(extracted2) ? extracted2 : null;
      } catch (error: any) {
        console.error("Forge-verify redraft error:", error instanceof ModelError ? error.kind : "unknown", error?.message);
        return c.json({ error: "Model request failed", status: 502 }, 502);
      }
      attempts.push(
        toAttemptRecord({
          attempt: 2,
          source: "forge-redraft",
          diff: redraft,
          parseAccepted: redraft !== null,
          applyCheckPassed: null,
        })
      );
      if (redraft === null) {
        return persistForgeRun(c, db, job, {
          runId, startedAt, history, status: "APPLY_FAILED",
          attempts, diff: activeDiff, source: activeSource,
        });
      }
      activeDiff = redraft;
      activeSource = "forge-redraft";
      history.push({ state: "PATCH_VALIDATING", at: new Date().toISOString() });
      try {
        check = await validatePatch(activeDiff);
      } catch (error: any) {
        console.error("Forge-verify validation error:", error?.message);
        return c.json({ error: "Sandbox validation failed", status: 502 }, 502);
      }
      attempts[1] = {
        ...attempts[1],
        applyCheckPassed: check.passed,
      } as typeof attempts[1];
      if (!check.passed) {
        return persistForgeRun(c, db, job, {
          runId, startedAt, history, status: "APPLY_FAILED",
          attempts, diff: activeDiff, source: activeSource,
        });
      }
    }

    history.push({ state: "APPLYING", at: new Date().toISOString() });
    const runStarted = Date.now();
    let result;
    try {
      const fullUpload = await uploadFile(sandbox, new TextEncoder().encode(activeDiff), {
        timeoutMs: 60000,
      });
      result = await runCommand(sandbox, {
        command: buildForgeVerifyScript(manager, excluded, verifyInvoke),
        image,
        files: { ...filesBase, [DIFF_STAGING_PATH]: { uuid: fullUpload.uuid } },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Forge-verify run error:", error?.message);
      return c.json({ error: "Sandbox run failed", status: 502 }, 502);
    }
    const durationMs = Date.now() - runStarted;

    const patchOk = result.stdout.includes(PATCH_OK_MARKER);
    const verifyBegin = result.stdout.includes(VERIFY_BEGIN_MARKER);
    const status = resolveForgeStatus({
      patchOk,
      verifyBegin,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    history.push(
      ...(patchOk
        ? [
            { state: "APPLIED", at: new Date().toISOString() },
            { state: "VERIFYING", at: new Date().toISOString() },
          ]
        : []),
      { state: status, at: new Date().toISOString() }
    );
    const entry = {
      id: runId,
      status,
      history,
      generationAttempts: attempts,
      patch: {
        source: activeSource,
        diffSha256: createHash("sha256").update(activeDiff).digest("hex"),
        diffBytes: new TextEncoder().encode(activeDiff).length,
      },
      apply: { applied: patchOk },
      verification: {
        command: verifyInvoke,
        commandSource,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        passed: status === "VERIFIED",
        assessment: assessVerification({
          patchApplied: patchOk,
          verificationStarted: verifyBegin,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          target: null,
        }),
      },
      image,
      manager,
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      durationMs,
      verified: status === "VERIFIED",
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { forgeRuns?: unknown[] } | null)?.forgeRuns ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), forgeRuns: [...prior, entry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, forgeRun: entry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

// POST /api/forge-structured - Structured-edit Forge lifecycle.
// Body: { jobId, focus (required), instruction?, ref?, image?, manager?,
// verificationCommand? }. The model produces a JSON edit plan (file,
// function, exact old/new texts) grounded on bounded source excerpts —
// never a unified diff. HUBRIS validates (schema, paths, exact-one-match
// against blob bytes), applies mechanically in a disposable sandbox,
// generates the canonical diff with git itself, checks it twice, then
// installs and runs verification (explicit command wins, else the repo's
// own test command; absent command is a 400).
// States: PROPOSED → EDIT_VALIDATING → EDIT_APPLIED → PATCH_VALIDATING →
// APPLYING → APPLIED → VERIFYING → VERIFIED, with EDIT_CONTEXT_MISMATCH /
// AMBIGUOUS_EDIT / PATCH_VALIDATION_FAILED / APPLY_FAILED / FAILED /
// TIMEOUT terminals. VERIFIED requires actual exit 0. Evidence lands on
// job.result.forgeRuns[] without breaking existing consumers.
app.post("/api/forge-structured", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = ForgeStructuredBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId and focus are required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) {
    return c.json({ error: "Job store unavailable", status: 503 }, 503);
  }

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) {
    return c.json({ error: "Job not found", status: 404 }, 404);
  }

  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  if (!cloneUrl) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const twin = job.result as TwinJobLike["result"];
  const twinFunctions = twin?.stats && twin.full?.functions ? twin.full.functions : null;
  if (job.status !== "complete" || !twinFunctions || twinFunctions.length === 0) {
    return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
  }

  // A Forge run is bound to the exact persisted investigation when one is
  // provided. The backend loads that investigation and derives the focus
  // from ITS plan — never from client-supplied focus text, the target name,
  // the URL, or the most recent investigation. Missing/invalid → fail
  // clearly. No fallback to another investigation.
  const handoffInvestigationId = parsed.data.investigationId;
  let effectiveFocus = parsed.data.focus;
  // The investigated target test file/scenario, used to run an EXACT targeted
  // verification. Null when the investigation named no reproduction.
  let targetTestFile: string | null = null;
  let targetScenario: string | null = null;
  if (handoffInvestigationId) {
    const runs = (job.result as { investigationRuns?: Array<Record<string, unknown>> } | null)
      ?.investigationRuns;
    const found = Array.isArray(runs)
      ? runs.find((r) => r.investigationId === handoffInvestigationId)
      : undefined;
    if (!found) {
      return c.json(
        { error: `Investigation ${handoffInvestigationId} not found on this job`, status: 400 },
        400
      );
    }
    const status = typeof found.status === "string" ? found.status : null;
    if (
      status !== "READY" ||
      typeof found.plan !== "object" ||
      found.plan === null ||
      !isGroundedRepairContract((found.plan as { repairContract?: unknown }).repairContract as Parameters<typeof isGroundedRepairContract>[0])
    ) {
      return c.json({ error: "Investigation is not READY for Forge", status: 400 }, 400);
    }
    effectiveFocus = composeForgeFocus(found.plan as Parameters<typeof composeForgeFocus>[0]);
    const reproduction = (found.plan as { reproduction?: { testFile?: unknown; scenario?: unknown } })
      .reproduction;
    targetTestFile =
      reproduction && typeof reproduction.testFile === "string" ? reproduction.testFile : null;
    targetScenario =
      reproduction && typeof reproduction.scenario === "string" ? reproduction.scenario : null;
  }

  const limits = limitsFromEnv();
  const execLimits = executionLimitsFromEnv();
  const timing = testTimingFromEnv();
  // Revision consistency: an explicit caller ref wins (same allow-list as
  // analysis); otherwise the job's persisted analyzed ref is authoritative
  // — never a silent default-branch fallback for a ref-pinned job. Legacy
  // jobs without any ref keep the previous default-branch behavior, and
  // the evidence says so explicitly.
  const jobRef = resolveJobRef(job.result);
  const analyzedCommitSha = resolveJobCommitSha(job.result);
  const ref = parsed.data.ref ?? jobRef ?? undefined;
  const refSource = parsed.data.ref
    ? ("requested" as const)
    : jobRef
      ? ("job" as const)
      : ("default" as const);
const image = parsed.data.image ?? "tag:node:20-slim";
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const history: Array<{ state: string; at: string }> = [
    { state: "PROPOSED", at: startedAt },
  ];
  const stamp = () => new Date().toISOString();

  async function persist(entry: object) {
    const persistedEntry = handoffInvestigationId
      ? { ...entry, investigationId: handoffInvestigationId }
      : entry;
    const prior = (job.result as { forgeRuns?: unknown[] } | null)?.forgeRuns ?? [];
    await db!
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), forgeRuns: [...prior, persistedEntry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, forgeRun: persistedEntry });
  }

  function editHash(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-forge-struct-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp, analyzedCommitSha ?? undefined);
    } catch (error: any) {
      if (error?.message === "revision-mismatch") {
        return c.json({ error: "Staged source does not match the analyzed commit.", status: 409 }, 409);
      }
      return repoStageFailure(c, error);
    }
    const { src, tarPath, tracked } = staged;
    // Exact analyzed revision, bound locally: the ref resolved above plus
    // the commit it resolved to. Both land on every persisted entry below.
    const commitSha = staged.commitSha ?? null;
    const sourceEvidence = {
      repoUrl: cloneUrl,
      analysisRef: jobRef,
      ref: ref ?? null,
      refSource,
      analysisCommitSha: analyzedCommitSha,
      executionCommitSha: commitSha,
      commitSha,
      tarballSha256: null as string | null,
    };
    if (analyzedCommitSha && commitSha !== analyzedCommitSha) {
      return c.json({ error: "Staged source does not match the analyzed commit.", status: 409 }, 409);
    }
    const excluded = tracked.filter(isTransferExcluded);
    const expected = tracked.length - excluded.length;
    if (expected <= 0) {
      return c.json({ error: "Repository has no transferable files", status: 400 }, 400);
    }
    if (tracked.length > limits.maxFiles) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tracked.length} files > ${limits.maxFiles})`, status: 413 },
        413
      );
    }

    const tarBytes = await fs.promises.readFile(tarPath);
    if (tarBytes.length > limits.maxBytes) {
      return c.json(
        { error: `Repository exceeds transfer limits (${tarBytes.length} bytes > ${limits.maxBytes})`, status: 413 },
        413
      );
    }
    const localSha = createHash("sha256").update(tarBytes).digest("hex");

    const detected = detectManager(tracked);
    const manager = parsed.data.manager ?? detected;
    if (!manager) {
      return c.json({ error: "No supported package manager detected", status: 400 }, 400);
    }
    const requested = parsed.data.verificationCommand;
    let verifyInvoke = requested;
    let commandSource = "requested";
    // Read the repo's declared test script even when a verification command is
    // supplied — it is how the targeted runner is detected.
    const declaredTestScript = await readPackageTestScript(src);
    if (!verifyInvoke) {
      if (!declaredTestScript) {
        return c.json({ error: "Repository has no test command", status: 400 }, 400);
      }
      verifyInvoke = `${manager} test`;
      commandSource = "detected";
    }
    // Targeted command for the exact investigated scenario (null when the
    // investigation named no scenario or the runner is unsupported).
    const targetCommand = buildTargetVerificationCommand({
      manager,
      testScript: declaredTestScript ?? verifyInvoke ?? null,
      testFile: targetTestFile,
      scenario: targetScenario,
    });

    // Source excerpts from blob bytes (identical to the tarball).
    const { blocks } = await buildSourceExcerpts(src, twinFunctions, effectiveFocus);
    if (blocks.length === 0) {
      return c.json({ error: "No source context for focus", status: 400 }, 400);
    }
    // Bounded excerpt metadata for the persisted run (never source text):
    // proves the model saw the target function anchored at its real line.
    const excerptMetadata = blocks.map((b) => ({
      path: b.path,
      function: b.function,
      lines: b.lines,
      anchorLine: b.anchorLine,
      targetIncluded: b.targetIncluded,
      truncated: b.truncated,
    }));

    const llm = llmConfigFromEnv();
    if (!llm) {
      return c.json({ error: "Model not configured", status: 503 }, 503);
    }
    let plan: ReturnType<typeof EditPlanSchema.parse>;
    try {
      const draft = await chatComplete(
        llm,
        [
          { role: "system", content: STRUCTURED_SYSTEM },
          {
            role: "user",
            content: buildStructuredPrompt({
              repoName:
                (twin?.repository as { name?: string } | undefined)?.name ?? job.repoUrl,
              excerpts: blocks,
              focus: effectiveFocus,
              instruction: parsed.data.instruction,
            }),
          },
        ],
        {
          maxTokens: forgeMaxTokens(),
          signal: budgetSignal(90000),
          // Verified contract: json_object constrains the model to valid
          // JSON. Parsing + zod + exact-match validation stay in place.
          responseFormat: "json_object",
        }
      );
      let raw: unknown;
      async function persistRejection(reason: string, draftText: string) {
        try {
          const prior =
            (job.result as { draftRejections?: unknown[] } | null)?.draftRejections ?? [];
          await db!
            .update(schema.jobs)
            .set({
              result: {
                ...(job.result as object),
                draftRejections: [
                  ...prior,
                  { ...buildRejectedDraftPreview(draftText, reason), at: new Date().toISOString() },
                ],
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, job.id));
        } catch {
          // best-effort; rejection stands regardless
        }
      }
      try {
        raw = JSON.parse(stripCodeFences(draft));
      } catch {
        await persistRejection("malformed edit plan", draft);
        // Metadata only: lengths, never draft text or values.
        console.error(
          "Forge-structured parse failure:",
          JSON.stringify({ reason: "malformed edit plan", draftChars: draft.length })
        );
        return c.json({ error: "Malformed edit plan", status: 400 }, 400);
      }
      // An empty plan is the model saying "nothing to change", not a broken
      // plan: typically the analyzed revision already satisfies the contract
      // (e.g. analyzing a branch without the defect). Still a failure with no
      // sandbox use — but reported as what it is, with the revision.
      if (isEmptyEditPlan(raw)) {
        await persistRejection("no edit proposed", draft);
        const revision = `${ref ?? "default branch"} @ ${(commitSha ?? "unknown").slice(0, 7)}`;
        return c.json(
          {
            error: `The model proposed no change for ${revision}. The analyzed source may already satisfy the repair contract — confirm the defect reproduces on this revision (Reproduce) before forging.`,
            code: "NO_EDIT_PROPOSED",
            status: 422,
          },
          422
        );
      }
      const check = EditPlanSchema.safeParse(raw);
      if (!check.success) {
        await persistRejection("invalid edit plan", draft);
        // Metadata only: issue codes + field paths, never received values.
        console.error(
          "Forge-structured schema failure:",
          JSON.stringify({
            reason: "invalid edit plan",
            draftChars: draft.length,
            issues: check.error.issues.map((i) => `${i.code}:${i.path.join(".")}`),
          })
        );
        return c.json({ error: "Invalid edit plan", status: 400 }, 400);
      }
      plan = check.data;
    } catch (error: any) {
      if (error instanceof ModelError) {
        console.error("Forge-structured draft error:", error.kind, error.message);
        if (error.kind === "timeout") {
          return c.json(
            {
              error: "The model did not return an edit plan in time — no sandbox run started. Try again; the model provider may be slow.",
              code: "MODEL_TIMEOUT",
              status: 504,
            },
            504
          );
        }
        return c.json({ error: "Model request failed", status: 502 }, 502);
      }
      throw error;
    }

    // Local gates: supported + tracked paths, exact-one-match on blob
    // bytes. Failures persist terminal entries with zero sandbox use.
    const trackedSet = new Set(tracked);
    const generation = {
      source: "forge" as const,
      format: "structured-edit" as const,
      focus: effectiveFocus,
      excerpts: excerptMetadata,
      edits: plan.edits.map((e) => ({
        path: e.path,
        function: e.function ?? null,
        oldTextHash: editHash(e.oldText),
        newTextHash: editHash(e.newText),
      })),
    };
    async function terminal(
      status: string,
      extra: Record<string, unknown> = {}
    ) {
      history.push({ state: status, at: stamp() });
      return persist({
        id: runId,
        status,
        history,
        generation,
        source: { ...sourceEvidence, tarballSha256: localSha },
        sandboxSource: null,
        canonicalPatch: null,
        validation: null,
        apply: { applied: false },
        verification: null,
        image,
        manager,
        workspace: REPO_WORKDIR,
        files: expected,
        bytes: tarBytes.length,
        sha256: localSha,
        durationMs: null,
        verified: false,
        stdout: "",
        stderr: "",
        at: stamp(),
        ...extra,
      });
    }

    history.push({ state: "EDIT_VALIDATING", at: stamp() });
    const blobCache = new Map<string, string | null>();
    async function blobOf(filePath: string): Promise<string | null> {
      if (!blobCache.has(filePath)) {
        try {
          const out = await execFileAsync(
            "git",
            ["-C", src, "-c", "core.autocrlf=false", "show", `HEAD:${filePath}`],
            { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
          );
          blobCache.set(filePath, out.stdout);
        } catch {
          blobCache.set(filePath, null);
        }
      }
      return blobCache.get(filePath) ?? null;
    }
    for (const e of plan.edits) {
      if (!isSupportedEditPath(e.path) || !trackedSet.has(e.path)) {
        return terminal("PATH_REJECTED", { rejectedPath: e.path });
      }
      const blob = await blobOf(e.path);
      if (blob === null) {
        return terminal("PATH_REJECTED", { rejectedPath: e.path });
      }
      const count = blob.split(e.oldText).length - 1;
      if (count === 0) {
        // Byte-exact mismatch against the authoritative analyzed revision.
        // Fail closed; persist a bounded diagnostic (never the model's full
        // text, never the file) so the cause is auditable.
        return terminal("EDIT_CONTEXT_MISMATCH", {
          rejectedPath: e.path,
          mismatch: describeSourceMismatch(blob, e.oldText),
        });
      }
      if (count > 1) {
        return terminal("AMBIGUOUS_EDIT", { rejectedPath: e.path });
      }
    }

    // A sandbox run that cannot finish inside the request's time budget would
    // only be cut off mid-flight: stop before any upload instead.
    const budgetLeft = remainingBudgetMs();
    if (budgetLeft !== null && budgetLeft < MIN_SANDBOX_BUDGET_MS) {
      return c.json(
        {
          error: `Not enough request time left to run the sandbox (${Math.floor(budgetLeft / 1000)}s remaining) — no sandbox run started.`,
          code: "BUDGET_EXHAUSTED",
          status: 504,
        },
        504
      );
    }

    // All edits validated locally: upload and run the full structured flow.
    let uploaded;
    let validatorUpload;
    let editsUpload;
    try {
      uploaded = await uploadFile(sandbox, tarBytes, { timeoutMs: 60000 });
      validatorUpload = await uploadFile(
        sandbox,
        new TextEncoder().encode(VALIDATOR_JS),
        { timeoutMs: 60000 }
      );
      editsUpload = await uploadFile(
        sandbox,
        new TextEncoder().encode(JSON.stringify({ edits: plan.edits })),
        { timeoutMs: 60000 }
      );
    } catch (error: any) {
      console.error("Forge-structured upload error:", error?.message);
      return c.json({ error: "Sandbox upload failed", code: "SANDBOX_UPLOAD_FAILED", status: 502 }, 502);
    }
    if (uploaded.sha256 !== localSha) {
      return c.json({ error: "Transfer integrity mismatch", status: 502 }, 502);
    }

    const runStarted = Date.now();
    let result;
    try {
      result = await runCommand(sandbox, {
        command: buildStructuredScript(
          manager,
          excluded,
          verifyInvoke,
          { ref: ref ?? null, sha: commitSha },
          targetCommand
        ),
        image,
        files: {
          [CHECKOUT_UPLOAD_PATH]: { uuid: uploaded.uuid },
          [STRUCTURED_UPLOAD_VALIDATOR]: { uuid: validatorUpload.uuid },
          [STRUCTURED_UPLOAD_EDITS]: { uuid: editsUpload.uuid },
        },
        shell: true,
        disposable: true,
        timeout: timing.timeoutS,
        truncateOutputAt: execLimits.maxOutputBytes,
        waitMs: timing.waitMs,
      });
    } catch (error: any) {
      console.error("Forge-structured run error:", error?.message);
      if (isSandboxWaitTimeout(error)) {
        return c.json(
          {
            error: "The sandbox run did not finish in time; no verification result was recorded.",
            code: "SANDBOX_TIMEOUT",
            status: 504,
          },
          504
        );
      }
      return c.json({ error: "Sandbox run failed", code: "SANDBOX_RUN_FAILED", status: 502 }, 502);
    }
    const durationMs = Date.now() - runStarted;

    // Trail reflects stages actually reached: validation always ran in the
    // sandbox run; edit/apply/verify states follow their markers.
    const outcome = parseStructuredRun(result.stdout);
    history.push({ state: "PATCH_VALIDATING", at: stamp() });
    // Source-revision gate: the sandbox must echo the exact revision the
    // server resolved. A mismatch (or missing markers) stops the lifecycle
    // BEFORE patch attribution — nothing is applied to the wrong revision.
    const echoed = parseSourceMarkers(result.stdout);
    const sandboxSource = {
      ref: echoed.ref,
      sha: echoed.sha,
      matched: sourceMarkersMatch(result.stdout, ref ?? null, commitSha),
    };
    let status: string;
    if (!sandboxSource.matched) {
      status = "SOURCE_MISMATCH";
    } else if (!outcome.editOk) {
      status =
        outcome.editCategory === "ambiguous"
          ? "AMBIGUOUS_EDIT"
          : outcome.editCategory === "path"
            ? "PATH_REJECTED"
            : outcome.editCategory === "mismatch"
              ? "EDIT_CONTEXT_MISMATCH"
              : "APPLY_FAILED";
    } else if (!outcome.patchOk) {
      history.push({ state: "EDIT_APPLIED", at: stamp() });
      status = "PATCH_VALIDATION_FAILED";
    } else {
      history.push({ state: "EDIT_APPLIED", at: stamp() });
      history.push({ state: "APPLIED", at: stamp() });
      history.push({ state: "VERIFYING", at: stamp() });
      status = resolveForgeStatus({
        patchOk: outcome.patchOk,
        verifyBegin: outcome.verifyBegin,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
    }
    history.push({ state: status, at: stamp() });
    // A revision mismatch voids all patch attribution: the workspace cannot
    // be proven to be the analyzed revision, so no apply/verify outcome
    // from it is admissible as evidence.
    const revisionOk = status !== "SOURCE_MISMATCH";
    // The EXACT canonical patch bytes echoed by the sandbox (base64). Persisted
    // only when sha256(content) and byte length match the reported canonical
    // patch; otherwise withheld so SHIP fails closed. Never reconstructed from
    // the model, edit plan, or contract.
    const canonicalContent = parseCanonicalPatchContent(result.stdout);
    const canonicalContentOk =
      outcome.canonicalSha !== null &&
      canonicalContent !== null &&
      canonicalContent.length > 0 &&
      createHash("sha256").update(canonicalContent).digest("hex") === outcome.canonicalSha &&
      Buffer.byteLength(canonicalContent, "utf-8") === outcome.canonicalBytes;
    // Exact targeted verification of the investigated scenario, when the
    // investigation supplied both a test file and a scenario name. A run that
    // never executed (unsupported runner / missing marker) is fail-closed.
    const targetRun = parseTargetVerification(result.stdout);
    const targetVerification: TargetVerificationInput | null =
      targetTestFile && targetScenario
        ? {
            testFile: targetTestFile,
            scenario: targetScenario,
            command: targetCommand ?? "",
            ran: targetRun.ran,
            exitCode: targetRun.exitCode,
            timedOut: result.timedOut,
          }
        : null;
    // User-facing verification assessment: exact target evidence + full-suite
    // regression status. Never infers the target result from the suite.
    const assessment = assessVerification({
      patchApplied: revisionOk && outcome.patchOk,
      verificationStarted: revisionOk && outcome.verifyBegin,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      target: targetVerification,
    });
    const entry = {
      id: runId,
      status,
      history,
      generation,
      source: { ...sourceEvidence, tarballSha256: localSha },
      sandboxSource,
      canonicalPatch:
        outcome.canonicalSha === null
          ? null
          : {
              sha: outcome.canonicalSha,
              bytes: outcome.canonicalBytes,
              ...(canonicalContentOk ? { content: canonicalContent } : {}),
            },
      validation: {
        editCategory: outcome.editCategory,
        canonicalPresent: outcome.canonicalSha !== null,
        patchValidated: outcome.patchOk,
      },
      apply: { applied: revisionOk && outcome.patchOk },
      // Bounded exact-target verification record (null when the investigation
      // named no scenario). Additive; the full-suite record is unchanged.
      targetVerification,
      // Verification evidence exists only when the verify command actually
      // started (marker seen). An install failure ends FAILED with null
      // verification rather than attributing install output to the command.
      verification: revisionOk && outcome.verifyBegin
        ? {
            command: verifyInvoke,
            commandSource,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            passed: status === "VERIFIED",
            assessment,
          }
        : null,
      image,
      manager,
      workspace: REPO_WORKDIR,
      files: expected,
      bytes: tarBytes.length,
      sha256: localSha,
      durationMs,
      verified: status === "VERIFIED",
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      at: stamp(),
    };
    const persistedEntry = handoffInvestigationId
      ? { ...entry, investigationId: handoffInvestigationId }
      : entry;
    const prior = (job.result as { forgeRuns?: unknown[] } | null)?.forgeRuns ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), forgeRuns: [...prior, persistedEntry] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, forgeRun: persistedEntry });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

const ShipBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  forgeRunId: z.string().min(1, "forgeRunId is required"),
  // Optional PR base. Defaults to the ref Forge analyzed. A different base is
  // honored only if it points at the very commit that was validated.
  baseBranch: z.string().min(1).max(200).optional(),
});

// POST /api/ship - Publish an already-verified Forge repair as a GitHub PR.
// Body: { jobId, forgeRunId }. The published patch is the EXACT canonical
// patch Forge validated and applied. SHIP never regenerates the patch, never
// force-pushes, never touches the default branch, and never merges. Any
// provenance or integrity mismatch fails closed.
app.post("/api/ship", async (c: Context) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }
  const parsed = ShipBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "jobId and forgeRunId are required", status: 400 }, 400);
  }

  const db = getDb();
  if (!db) return c.json({ error: "Job store unavailable", status: 503 }, 503);

  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId));
  const job = rows[0];
  if (!job) return c.json({ error: "Job not found", status: 404 }, 404);

  const result = job.result as { forgeRuns?: unknown[]; investigationRuns?: unknown[] } | null;
  const runs = Array.isArray(result?.forgeRuns) ? (result!.forgeRuns as unknown[]) : [];
  const run = runs.find(
    (r): r is ForgeRunLike =>
      typeof r === "object" && r !== null && (r as { id?: unknown }).id === parsed.data.forgeRunId
  );
  if (!run) return c.json({ error: "Forge run not found", status: 404 }, 404);

  // 1. Eligibility (assessment + applied + patch presence).
  const eligibility = shipEligibility(run);
  if (!eligibility.ok) {
    return c.json(
      { error: `Cannot create PR. ${eligibility.reason}`, state: "NOT_READY", status: 409 },
      409
    );
  }

  // 2. Bound investigation must be a persisted READY run.
  const investigationId = typeof run.investigationId === "string" ? run.investigationId : null;
  const investigations = Array.isArray(result?.investigationRuns)
    ? (result!.investigationRuns as unknown[])
    : [];
  const investigation = investigations.find(
    (r): r is Record<string, unknown> =>
      typeof r === "object" &&
      r !== null &&
      (r as { investigationId?: unknown }).investigationId === investigationId &&
      (r as { status?: unknown }).status === "READY"
  );
  const provenanceReason =
    "Cannot create PR. The verified repair provenance could not be established. Re-run Forge.";
  if (!investigationId || !investigation) {
    return c.json({ error: provenanceReason, status: 409 }, 409);
  }

  // 3. Repository must be the analyzed job's public github repository.
  const cloneUrl = toSafeCloneUrl(job.repoUrl);
  const repository = shipRepoNameFromCloneUrl(cloneUrl);
  if (!cloneUrl || !repository) {
    return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
  }

  // 4. Provenance gate (repository, investigation, commit binding, equality).
  if (!verifyShipProvenance(run, { repository, jobRepoUrl: job.repoUrl, investigationId }).ok) {
    return c.json({ error: provenanceReason, status: 409 }, 409);
  }

  // 5. Canonical patch integrity — the exact bytes Forge verified.
  const patch = verifyCanonicalPatch(run.canonicalPatch as never);
  if (!patch.ok || !patch.content) {
    return c.json({ error: `Cannot create PR. ${patch.reason}`, status: 409 }, 409);
  }
  const canonicalPatchSha = (run.canonicalPatch as { sha: string }).sha;
  const source = (run.source ?? {}) as {
    analysisCommitSha?: unknown;
    executionCommitSha?: unknown;
    commitSha?: unknown;
    ref?: unknown;
    analysisRef?: unknown;
  };
  // The ref Forge actually staged and verified (falls back to the analysis
  // ref). Null for legacy runs with no recorded ref: those analyzed the
  // repository's default branch.
  const verifiedRef =
    typeof source.ref === "string" && source.ref
      ? source.ref
      : typeof source.analysisRef === "string" && source.analysisRef
        ? source.analysisRef
        : null;
  const analyzedCommitSha =
    typeof source.analysisCommitSha === "string" ? source.analysisCommitSha : "";
  const executionCommitSha =
    typeof source.executionCommitSha === "string"
      ? source.executionCommitSha
      : typeof source.commitSha === "string"
        ? source.commitSha
        : "";

  // 6. Duplicate PR safety (persisted).
  const duplicate = findExistingPullRequest(runs, { repository, investigationId, canonicalPatchSha });
  if (duplicate) {
    return c.json({ jobId: job.id, duplicate: true, pullRequest: duplicate, state: "PR_EXISTS" });
  }

  // 7. GitHub authorization — reuse the existing env token.
  const token = githubTokenFromEnv();
  if (!token) {
    return c.json(
      {
        error: "GitHub authorization is required to create a pull request.",
        state: "ACTION_REQUIRED",
        status: 503,
      },
      503
    );
  }
  const owner = repository.split("/")[0];
  const base = await getDefaultBranch(token, repository, fetch);
  if (!base.ok || !base.branch) {
    const auth = base.status === 401 || base.status === 403;
    const status: ContentfulStatusCode = auth ? 403 : 502;
    return c.json(
      {
        error: auth
          ? "GitHub authorization required. HUBRIS could not read the repository with the configured token."
          : redactSecrets(`GitHub repository could not be read: ${base.error}`, token),
        state: auth ? "ACTION_REQUIRED" : "NOT_READY",
        status,
      },
      status
    );
  }

  // 7b. PR base. Defaults to the analyzed ref (a non-default branch included);
  //     only a legacy run with no recorded ref uses the repository default.
  //     Source freshness and base compatibility are enforced against the exact
  //     refs inside shipForgeRun, before any GitHub write.
  const baseChoice = resolveShipBase({
    analysisRef: verifiedRef,
    defaultBranch: base.branch,
    requestedBase: parsed.data.baseBranch ?? null,
  });
  if (!baseChoice.ok) {
    return c.json({ error: `Cannot create PR. ${baseChoice.reason}`, state: "NOT_READY", code: "BASE_INVALID", status: 400 }, 400);
  }

  // 8. Deterministic metadata built from persisted evidence.
  const plan = (investigation.plan ?? {}) as Record<string, unknown>;
  const target = (plan.target ?? {}) as { function?: unknown; file?: unknown };
  const targetFunction = typeof target.function === "string" ? target.function : "";
  const targetFile = typeof target.file === "string" ? target.file : "";
  const report = typeof investigation.focus === "string" ? investigation.focus : "";
  const candidateBranch = shipBranchName(targetFunction, report, investigationId);
  const existingBranches = runs
    .map((r) =>
      typeof r === "object" && r !== null
        ? (r as { pullRequest?: { branch?: unknown } }).pullRequest?.branch
        : null
    )
    .filter((b): b is string => typeof b === "string");
  const branch = uniqueShipBranch(candidateBranch, existingBranches);
  const title = buildPullRequestTitle(targetFunction, report);
  // Body comes from the exact finalized Forge run being shipped.
  const body = buildPullRequestBodyFromRun(run, {
    repoName: repository,
    targetFunction,
    targetFile,
    currentBehavior: typeof plan.currentBehavior === "string" ? plan.currentBehavior : "",
    expectedBehavior: typeof plan.expectedBehavior === "string" ? plan.expectedBehavior : "",
    investigationId,
    forgeRunId: parsed.data.forgeRunId,
    analyzedCommitSha,
    executionCommitSha,
    canonicalPatchSha,
  });

  // 9. Publish: clone at the exact commit, apply the exact patch, push a
  //    hubris/* branch, open a PR. Fail closed on any deviation.
  const shipped = await shipForgeRun({
    repository,
    owner,
    commitSha: analyzedCommitSha,
    analysisRef: baseChoice.analysisRef,
    baseBranch: baseChoice.baseBranch,
    branch,
    patchContent: patch.content,
    canonicalPatchSha,
    title,
    body,
    token,
  });
  if (!shipped.ok) {
    const auth = shipped.kind === "auth";
    const stale = /changed since this repair was verified/.test(shipped.reason);
    const baseBlocked = shipped.kind === "base";
    const runtimeBlocked = shipped.kind === "runtime";
    const status: ContentfulStatusCode = auth
      ? 403
      : runtimeBlocked
        ? 503
        : shipped.kind === "conflict" || stale || baseBlocked
          ? 409
          : 502;
    return c.json(
      {
        error: shipped.reason,
        state: auth ? "ACTION_REQUIRED" : "NOT_READY",
        ...(baseBlocked ? { code: "BASE_NOT_VALIDATED" } : {}),
        ...(runtimeBlocked ? { code: "GIT_UNAVAILABLE" } : {}),
        analysisRef: baseChoice.analysisRef,
        baseBranch: baseChoice.baseBranch,
        status,
      },
      status
    );
  }

  const record: PullRequestRecord = {
    ...(shipped.pullRequest ?? shipped.duplicate)!,
    investigationId,
    forgeRunId: parsed.data.forgeRunId,
  };
  if (shipped.pullRequest) {
    const updatedRuns = runs.map((r) =>
      typeof r === "object" && r !== null && (r as { id?: unknown }).id === parsed.data.forgeRunId
        ? { ...(r as object), pullRequest: record }
        : r
    );
    try {
      await db
        .update(schema.jobs)
        .set({ result: { ...(job.result as object), forgeRuns: updatedRuns }, updatedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
    } catch (error: any) {
      console.error("Ship persist error:", error?.message);
    }
  }
  return c.json({
    jobId: job.id,
    pullRequest: record,
    analysisRef: baseChoice.analysisRef,
    baseBranch: record.baseBranch,
    pushStatus: shipped.pushStatus ?? null,
    state: "PR_CREATED",
  });
});

// POST /api/diagnostics/git - Run the git capability checks INSIDE this runtime
// (version, public ls-remote, temp repo, diff --check, apply --check, cleanup).
// Not a public diagnostics page: it requires HUBRIS_API_KEY to be configured AND
// presented (a keyless public deployment answers 403), is POST-only, and caches
// its result briefly so it cannot be used to hammer the network. Read-only
// toward the outside world; no credentials, no pushes, no GitHub writes.
const DIAGNOSTICS_CACHE_MS = 30_000;
let lastGitDiagnostics: { at: number; report: GitDiagReport } | null = null;

export function resetGitDiagnosticsCache(): void {
  lastGitDiagnostics = null;
}

app.post("/api/diagnostics/git", async (c: Context) => {
  const keyConfigured = Boolean(process.env.HUBRIS_API_KEY);
  // The key guard already rejected a wrong/missing key when one is configured.
  // Without a key the endpoint is only available off-platform (local dev).
  if (!keyConfigured && process.env.VERCEL) {
    return c.json(
      { error: "Diagnostics are disabled until HUBRIS_API_KEY is configured.", status: 403 },
      403
    );
  }
  const now = Date.now();
  if (lastGitDiagnostics && now - lastGitDiagnostics.at < DIAGNOSTICS_CACHE_MS) {
    return c.json({ ...lastGitDiagnostics.report, cached: true }, lastGitDiagnostics.report.ok ? 200 : 503);
  }
  const probe = process.env.HUBRIS_GIT_PROBE_REPO;
  const report = await runGitDiagnostics({
    probeRepo: probe && isSafeProbeUrl(probe) ? probe : DEFAULT_PROBE_REPO,
  });
  lastGitDiagnostics = { at: now, report };
  console.info(
    `[hubris] git diagnostics ${report.ok ? "PASSED" : "FAILED"}: ` +
      report.steps.map((s) => `${s.step}=${s.ok ? "ok" : s.code}`).join(" ")
  );
  return c.json({ ...report, cached: false }, report.ok ? 200 : 503);
});

// GET /health - Liveness. Never touches a dependency.
app.get("/health", (c: Context) => {
  return c.json({ status: "ok", service: "hubris-api" });
});

// GET /ready - Readiness: database reachable, `git` present, and which
// integrations are configured (booleans only, never values). 503 when the API
// cannot do its core work on this host.
app.get("/ready", async (c: Context) => {
  const report = await readiness({
    databaseCheck: async () => {
      const db = getDb();
      if (!db) return "not-configured";
      try {
        await Promise.race([
          db.execute(sql`select 1`),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        return "ok";
      } catch {
        return "error";
      }
    },
  });
  return c.json(report, report.status === "ready" ? 200 : 503);
});

// Vercel's Hono integration runs the DEFAULT EXPORT of this file as the
// function; the local Node server (src/local.ts) imports the same app.
export default app;
