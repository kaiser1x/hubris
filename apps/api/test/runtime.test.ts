import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  apiKeyGuard,
  budgetSignal,
  COMMAND_MARGIN_S,
  fitSandboxRequest,
  FUNCTION_RESERVE_MS,
  functionMaxDurationMs,
  readiness,
  remainingBudgetMs,
  requestBudget,
  VERCEL_DEFAULT_MAX_DURATION_S,
} from "../src/runtime";
import appDefault from "../src/app";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("function duration", () => {
  it("is unbounded locally and 300s (the platform default) on Vercel", () => {
    expect(functionMaxDurationMs({})).toBeNull();
    expect(functionMaxDurationMs({ VERCEL: "1" })).toBe(VERCEL_DEFAULT_MAX_DURATION_S * 1000);
  });

  it("HUBRIS_FUNCTION_MAX_DURATION_S overrides it (match the project's Default Max Duration)", () => {
    expect(functionMaxDurationMs({ VERCEL: "1", HUBRIS_FUNCTION_MAX_DURATION_S: "800" })).toBe(800_000);
    expect(functionMaxDurationMs({ HUBRIS_FUNCTION_MAX_DURATION_S: "60" })).toBe(60_000);
  });

  it("ignores nonsense values", () => {
    expect(functionMaxDurationMs({ VERCEL: "1", HUBRIS_FUNCTION_MAX_DURATION_S: "abc" })).toBe(300_000);
    expect(functionMaxDurationMs({ VERCEL: "1", HUBRIS_FUNCTION_MAX_DURATION_S: "-5" })).toBe(300_000);
    expect(functionMaxDurationMs({ HUBRIS_FUNCTION_MAX_DURATION_S: "0" })).toBeNull();
  });
});

describe("request time budget", () => {
  function probe() {
    const mini = new Hono();
    mini.use("*", requestBudget());
    mini.get("/left", (c) => c.json({ remaining: remainingBudgetMs() }));
    return mini;
  }

  it("is unbounded without a platform limit", async () => {
    const res = await probe().request("/left");
    expect((await res.json()).remaining).toBeNull();
  });

  it("counts down from max duration minus the reserve, per request", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("HUBRIS_FUNCTION_MAX_DURATION_S", "100");
    const { remaining } = await (await probe().request("/left")).json();
    expect(remaining).toBeLessThanOrEqual(100_000 - FUNCTION_RESERVE_MS);
    expect(remaining).toBeGreaterThan(100_000 - FUNCTION_RESERVE_MS - 2_000);
  });

  it("outside a request scope there is nothing to clamp", () => {
    vi.stubEnv("VERCEL", "1");
    expect(remainingBudgetMs()).toBeNull();
  });

  it("a model-call signal never outlives the budget", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("HUBRIS_FUNCTION_MAX_DURATION_S", "17"); // 2s usable
    const mini = new Hono();
    mini.use("*", requestBudget());
    mini.get("/sig", async (c) => {
      const signal = budgetSignal(90_000);
      const started = Date.now();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return c.json({ waitedMs: Date.now() - started });
    });
    const { waitedMs } = await (await mini.request("/sig")).json();
    expect(waitedMs).toBeLessThan(3_500);
  });
});

describe("fitSandboxRequest", () => {
  it("leaves a request alone when there is no limit or it already fits", () => {
    const req = { command: "x", timeout: 120, waitMs: 150_000 };
    expect(fitSandboxRequest(req, null)).toBe(req);
    expect(fitSandboxRequest(req, 400_000)).toBe(req);
  });

  it("clamps the poll budget AND makes the sandbox kill the command first", () => {
    const fitted = fitSandboxRequest({ command: "x", timeout: 600, waitMs: 660_000 }, 120_000);
    expect(fitted.waitMs).toBe(120_000);
    // The server-side timeout fires before the poll gives up, so the run comes
    // back as a clean timedOut result that HUBRIS persists — not an abandoned op.
    expect(fitted.timeout).toBe(120 - COMMAND_MARGIN_S);
    expect(fitted.timeout! * 1000).toBeLessThan(fitted.waitMs!);
  });

  it("applies a ceiling even when the request set no timeout, and never goes below 1s", () => {
    expect(fitSandboxRequest({ command: "x", waitMs: 600_000 }, 60_000)).toMatchObject({ waitMs: 60_000, timeout: 55 });
    const tiny = fitSandboxRequest({ command: "x", timeout: 120, waitMs: 150_000 }, 0);
    expect(tiny.waitMs).toBe(1_000);
    expect(tiny.timeout).toBe(1);
  });

  it("never raises a smaller timeout", () => {
    const fitted = fitSandboxRequest({ command: "x", timeout: 30, waitMs: 660_000 }, 120_000);
    expect(fitted.timeout).toBe(30);
  });

  it("does not mutate its input", () => {
    const req = { command: "x", timeout: 600, waitMs: 660_000 };
    fitSandboxRequest(req, 10_000);
    expect(req).toEqual({ command: "x", timeout: 600, waitMs: 660_000 });
  });
});

describe("HUBRIS_API_KEY guard", () => {
  const guarded = () => {
    const mini = new Hono();
    mini.use("*", apiKeyGuard());
    mini.get("/health", (c) => c.text("ok"));
    mini.get("/api/thing", (c) => c.text("secret-data"));
    mini.post("/api/thing", (c) => c.text("written"));
    return mini;
  };

  it("is open when no key is configured (local development)", async () => {
    expect((await guarded().request("/api/thing")).status).toBe(200);
  });

  it("rejects missing and wrong keys with the standard error shape; accepts the right one", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    const missing = await guarded().request("/api/thing");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized", status: 401 });
    for (const bad of ["wrong", "s3cret-valu", "s3cret-value-x", ""]) {
      const res = await guarded().request("/api/thing", { headers: { "x-hubris-api-key": bad } });
      expect(res.status, bad).toBe(401);
    }
    const post = await guarded().request("/api/thing", { method: "POST" });
    expect(post.status).toBe(401);
    const ok = await guarded().request("/api/thing", { headers: { "x-hubris-api-key": "s3cret-value" } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("secret-data");
  });

  it("keeps /health open for platform liveness checks", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    expect((await guarded().request("/health")).status).toBe(200);
  });

  it("guards the real app: no route runs (and no job is read) without the key", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    const res = await appDefault.request("/api/jobs");
    expect(res.status).toBe(401);
    const ship = await appDefault.request("/api/ship", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "x", forgeRunId: "y" }),
    });
    expect(ship.status).toBe(401);
    const ready = await appDefault.request("/ready");
    expect(ready.status).toBe(401);
    expect((await appDefault.request("/health")).status).toBe(200);
    // With the key, the request reaches the route (validation error, not 401).
    const through = await appDefault.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hubris-api-key": "s3cret-value" },
      body: "{}",
    });
    expect(through.status).toBe(400);
  });
});

describe("readiness", () => {
  const git = async () => ({ available: true, version: "2.45.0" });

  it("is ready only with a database and a git binary", async () => {
    const ok = await readiness({ databaseCheck: async () => "ok", gitProbe: git, env: {} });
    expect(ok.status).toBe("ready");
    const noGit = await readiness({ databaseCheck: async () => "ok", gitProbe: async () => ({ available: false }), env: {} });
    expect(noGit.status).toBe("degraded");
    const noDb = await readiness({ databaseCheck: async () => "not-configured", gitProbe: git, env: {} });
    expect(noDb.status).toBe("degraded");
    const dbDown = await readiness({ databaseCheck: async () => "error", gitProbe: git, env: {} });
    expect(dbDown.status).toBe("degraded");
  });

  it("reports which integrations are configured as booleans, never their values", async () => {
    const env = {
      NEBIUS_API_KEY: "key-value-123",
      NEBIUS_MODEL: "model-x",
      NEBIUS_PROJECT_ID: "proj-456",
      GITHUB_TOKEN: "ghp_secret789",
      DATABASE_URL: "postgresql://user:pw@host/db",
      VERCEL: "1",
    };
    const report = await readiness({ databaseCheck: async () => "ok", gitProbe: git, env });
    expect(report.checks).toMatchObject({ sandbox: true, llm: true, github: true });
    expect(report.runtime).toEqual({ platform: "vercel", functionMaxDurationS: 300 });
    const text = JSON.stringify(report);
    for (const secret of Object.values(env).filter((v) => v !== "1")) expect(text).not.toContain(secret);
    const bare = await readiness({ databaseCheck: async () => "ok", gitProbe: git, env: {} });
    expect(bare.checks).toMatchObject({ sandbox: false, llm: false, github: false });
    expect(bare.runtime).toEqual({ platform: "node", functionMaxDurationS: null });
  });

  it("GET /ready answers 503 when the database is not configured, with no values in the body", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("GITHUB_TOKEN", "ghp_do_not_leak");
    const res = await appDefault.request("/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe("not-configured");
    expect(body.checks.github).toBe(true);
    expect(JSON.stringify(body)).not.toContain("ghp_do_not_leak");
  });
});
