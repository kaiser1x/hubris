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
  buildForgePrompt,
  buildInvestigatePrompt,
  chatComplete,
  llmConfigFromEnv,
} from "@hubris/llm";
import { buildRepoCheckoutCommand, isSafeGitRef, runCommand, sandboxConfigFromEnv } from "@hubris/sandbox";

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
    const result = await runCommand(sandbox, {
      command,
      image: parsed.data.image ?? "tag:busybox:latest",
      shell: true,
      disposable: true,
      timeout: 120,
      waitMs: 150000,
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
    const result = await runCommand(sandbox, {
      command,
      image: parsed.data.image ?? "tag:busybox:latest",
      shell: true,
      disposable: true,
      timeout: 120,
      waitMs: 150000,
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

// GET /health - Health check
app.get("/health", (c: Context) => {
  return c.json({ status: "ok", service: "hubris-api" });
});
