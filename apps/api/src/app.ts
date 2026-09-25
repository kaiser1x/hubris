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

// GET /health - Health check
app.get("/health", (c: Context) => {
  return c.json({ status: "ok", service: "hubris-api" });
});
