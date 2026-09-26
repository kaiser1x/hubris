import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { analyzeRepository } from "@hubris/analyzer";
import { getDb, schema } from "@hubris/db";
import {
  FORGE_SYSTEM,
  INVESTIGATE_SYSTEM,
  REGRESSION_SYSTEM,
  buildForgePrompt,
  buildInvestigatePrompt,
  buildRegressionPrompt,
  chatComplete,
  llmConfigFromEnv,
  stripCodeFences,
} from "@hubris/llm";
import { createHash } from "crypto";
import { buildRepoCheckoutCommand, executionLimitsFromEnv, isSafeGitRef, REPO_WORKDIR, runCommand, sandboxConfigFromEnv, uploadFile } from "@hubris/sandbox";
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
  parseTestCommand,
  TEST_BEGIN_MARKER,
  testTimingFromEnv,
} from "./testrun";
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

const execFileAsync = promisify(execFile);

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

const AnalyzeBody = z.object({
  repoUrl: z.string().min(1, "repoUrl is required"),
});

const InvestigateBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  question: z.string().max(2000).optional(),
});

const ForgeBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  focus: z.string().max(200).optional(),
  instruction: z.string().max(2000).optional(),
});

const GitRef = z
  .string()
  .max(100)
  .refine((r) => isSafeGitRef(r), "Invalid ref");

const ReproduceBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  script: z.string().min(1).max(4000),
  image: z.string().max(200).optional(),
  checkout: z.boolean().optional(),
  ref: GitRef.optional(),
});

const VerifyBody = z.object({
  jobId: z.string().min(1, "jobId is required"),
  script: z.string().min(1).max(4000),
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

function shortPath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-3).join("/");
}

// Rewrite absolute clone-dir paths to repo-relative posix paths so stored
// twins never leak the server's temp directory.
export function toRepoRelative(tmp: string, abs: string): string {
  const rel = path.relative(tmp, abs);
  if (rel === "" || rel.startsWith("..")) return abs;
  return rel.split(path.sep).join("/");
}

export const app = new Hono();

// GET /api/analyze?repo=owner/repo - Analyze a GitHub repo
app.get("/api/analyze", async (c: Context) => {
  const { repo } = c.req.query();
  if (!repo) {
    return c.json({ error: "repo query parameter is required (format: owner/repo)", status: 400 }, 400);
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
      await execFileAsync("git", ["clone", "--depth", "1", cloneUrl, tmp], {
        timeout: 90000,
      });
      const started = Date.now();
      const twin = await analyzeRepository(tmp);
      twin.name = cloneUrl.split("/").slice(-2).join("/").replace(/\.git$/, "");
      for (const fn of twin.functions) fn.path = toRepoRelative(tmp, fn.path);
      for (const cls of twin.classes) cls.path = toRepoRelative(tmp, cls.path);
      for (const e of twin.endpoints) e.file = toRepoRelative(tmp, e.file);
      for (const t of twin.tests) {
        t.path = toRepoRelative(tmp, t.path);
        t.file = toRepoRelative(tmp, t.file);
      }
      for (const r of twin.relationships) r.from = toRepoRelative(tmp, r.from);
      const payload = {
        jobId,
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
      if (db) {
        await db
          .update(schema.jobs)
          .set({
            status: "complete",
            result: {
              ...payload,
              full: {
                functions: twin.functions,
                classes: twin.classes,
                endpoints: twin.endpoints,
                tests: twin.tests,
                relationships: twin.relationships,
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
    console.error("Analyze error:", error?.message);
    const msg = error?.killed
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
    return c.json({ error: msg, status: 500 }, 500);
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
  const base = db.select().from(schema.jobs).$dynamic();
  const rows = repoUrl
    ? await base.where(eq(schema.jobs.repoUrl, repoUrl)).orderBy(desc(schema.jobs.createdAt)).limit(limit)
    : await base.orderBy(desc(schema.jobs.createdAt)).limit(limit);
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
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  const parsed = InvestigateBody.safeParse(rawBody);
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
    sample?: { functions?: Array<{ name?: string }>; endpoints?: Array<{ method?: string; path?: string }> };
    full?: {
      functions?: Array<{ name?: string; path?: string; line?: number }>;
      endpoints?: Array<{ method?: string; path?: string; file?: string }>;
      relationships?: Array<{ from?: string; to?: string; type?: string; caller?: string }>;
    };
  } | null;
  if (job.status !== "complete" || !result?.stats) {
    return c.json({ error: "Job has no completed analysis", status: 400 }, 400);
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
      { signal: AbortSignal.timeout(60000) }
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

  const fullFunctions = result.full?.functions ?? [];
  const prompt = buildForgePrompt(
    {
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
      focus: parsed.data.focus,
      instruction: parsed.data.instruction,
    }
  );

  try {
    const suggestion = await chatComplete(
      llm,
      [
        { role: "system", content: FORGE_SYSTEM },
        { role: "user", content: prompt },
      ],
      { maxTokens: 1200, signal: AbortSignal.timeout(90000) }
    );
    return c.json({
      jobId: job.id,
      suggestion,
      verified: false,
      note: "Proposal only — nothing was applied. Sandbox verification pending.",
    });
  } catch (error: any) {
    console.error("Forge error:", error?.message);
    return c.json({ error: "Model request failed", status: 502 }, 502);
  }
});

// POST /api/reproduce - Run a repro script in a disposable sandbox and
// store the evidence (exit code, stdout, stderr) on the job.
// Body: { jobId, script, image?, checkout?, ref? }. Script is capped at
// 4000 chars; stored streams are truncated to protect the row.
// checkout:true clones the job's repoUrl into the sandbox and runs the
// script from the checkout (branch/tag via ref). Default false preserves
// the original self-contained mode.
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

  const sandbox = sandboxConfigFromEnv();
  if (!sandbox) {
    return c.json({ error: "Sandbox not configured", status: 503 }, 503);
  }

  const checkout = parsed.data.checkout ?? false;
  const ref = parsed.data.ref;
  let command = parsed.data.script;
  if (checkout) {
    try {
      command = buildRepoCheckoutCommand(job.repoUrl, parsed.data.script, ref);
    } catch {
      return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
    }
  }

  try {
    const limits = executionLimitsFromEnv();
    const result = await runCommand(sandbox, {
      command,
      image: parsed.data.image ?? "tag:busybox:latest",
      shell: true,
      disposable: true,
      timeout: limits.commandTimeoutS,
      truncateOutputAt: limits.maxOutputBytes,
      waitMs: limits.waitMs,
    });
    const evidence = {
      script: parsed.data.script,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      timedOut: result.timedOut,
      checkout,
      ...(checkout ? { repoUrl: job.repoUrl, ...(ref ? { ref } : {}) } : {}),
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
  } catch (error: any) {
    console.error("Reproduce error:", error?.message);
    return c.json({ error: "Sandbox run failed", status: 502 }, 502);
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

  const checkout = parsed.data.checkout ?? false;
  const ref = parsed.data.ref;
  let command = parsed.data.script;
  if (checkout) {
    try {
      command = buildRepoCheckoutCommand(job.repoUrl, parsed.data.script, ref);
    } catch {
      return c.json({ error: "Job has unsupported repo URL", status: 400 }, 400);
    }
  }

  try {
    const limits = executionLimitsFromEnv();
    const result = await runCommand(sandbox, {
      command,
      image: parsed.data.image ?? "tag:busybox:latest",
      shell: true,
      disposable: true,
      timeout: limits.commandTimeoutS,
      truncateOutputAt: limits.maxOutputBytes,
      waitMs: limits.waitMs,
    });
    const verification = {
      script: parsed.data.script,
      exitCode: result.exitCode,
      passed: result.exitCode === 0 && !result.timedOut,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 4000),
      timedOut: result.timedOut,
      checkout,
      ...(checkout ? { repoUrl: job.repoUrl, ...(ref ? { ref } : {}) } : {}),
      at: new Date().toISOString(),
    };
    const prior = (job.result as { verifications?: unknown[] } | null)?.verifications ?? [];
    await db
      .update(schema.jobs)
      .set({
        result: { ...(job.result as object), verifications: [...prior, verification] },
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, job.id));
    return c.json({ jobId: job.id, verification });
  } catch (error: any) {
    console.error("Verify error:", error?.message);
    return c.json({ error: "Sandbox run failed", status: 502 }, 502);
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
  const ref = parsed.data.ref;
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-checkout-"));
  try {
    let staged;
    try {
      staged = await cloneAndArchive(cloneUrl, ref, tmp);
    } catch (error: any) {
      const step =
        error?.message === "clone"
          ? "clone"
          : error?.message === "ls-files"
            ? "listing"
            : "archive";
      return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
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
      const step =
        error?.message === "clone"
          ? "clone"
          : error?.message === "ls-files"
            ? "listing"
            : "archive";
      return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
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
      const step =
        error?.message === "clone"
          ? "clone"
          : error?.message === "ls-files"
            ? "listing"
            : "archive";
      return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
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
      let pkgText: string | null = null;
      try {
        pkgText = await fs.promises.readFile(path.join(src, "package.json"), "utf-8");
      } catch {
        pkgText = null;
      }
      declared = pkgText ? parseTestCommand(pkgText) : null;
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
        { maxTokens: 1200, signal: AbortSignal.timeout(90000) }
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
      const step =
        error?.message === "clone"
          ? "clone"
          : error?.message === "ls-files"
            ? "listing"
            : "archive";
      return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
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
      const step =
        error?.message === "clone"
          ? "clone"
          : error?.message === "ls-files"
            ? "listing"
            : "archive";
      return c.json({ error: `Repository ${step} failed`, status: 500 }, 500);
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

// GET /health - Health check
app.get("/health", (c: Context) => {
  return c.json({ status: "ok", service: "hubris-api" });
});
