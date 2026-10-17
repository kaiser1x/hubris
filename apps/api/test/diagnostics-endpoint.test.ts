import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const diag = vi.hoisted(() => ({
  calls: 0,
  probeRepos: [] as Array<string | undefined>,
  report: {
    ok: true,
    gitVersion: "2.45.1",
    steps: [{ step: "version", ok: true, ms: 3, detail: "git 2.45.1" }],
    at: "2026-10-17T00:00:00.000Z",
  } as Record<string, unknown>,
}));

vi.mock("../src/gitdiag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gitdiag")>();
  return {
    ...actual,
    runGitDiagnostics: vi.fn(async (opts?: { probeRepo?: string }) => {
      diag.calls += 1;
      diag.probeRepos.push(opts?.probeRepo);
      return diag.report;
    }),
  };
});

import appDefault, { resetGitDiagnosticsCache } from "../src/app";
import { coldStartGitCheck, resetColdStartCheck } from "../src/runtime";
import { Hono } from "hono";

const post = (headers: Record<string, string> = {}) =>
  appDefault.request("/api/diagnostics/git", { method: "POST", headers });

beforeEach(() => {
  diag.calls = 0;
  diag.probeRepos = [];
  diag.report = { ok: true, gitVersion: "2.45.1", steps: [{ step: "version", ok: true, ms: 3 }], at: "2026-10-17T00:00:00.000Z" };
  resetGitDiagnosticsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/diagnostics/git is not a public diagnostics endpoint", () => {
  it("on Vercel without HUBRIS_API_KEY it refuses (403) and runs nothing", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("HUBRIS_API_KEY", "");
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/HUBRIS_API_KEY/);
    expect(diag.calls).toBe(0);
  });

  it("with a key configured, a missing or wrong key is 401 and runs nothing", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    expect((await post()).status).toBe(401);
    expect((await post({ "x-hubris-api-key": "nope" })).status).toBe(401);
    expect(diag.calls).toBe(0);
  });

  it("is POST-only: a GET (crawlers, link prefetch) never triggers it", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    const res = await appDefault.request("/api/diagnostics/git", { headers: { "x-hubris-api-key": "s3cret-value" } });
    expect(res.status).toBe(404);
    expect(diag.calls).toBe(0);
  });

  it("with the key it runs and returns the step report", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    const res = await post({ "x-hubris-api-key": "s3cret-value" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, gitVersion: "2.45.1", cached: false });
    expect(diag.calls).toBe(1);
  });

  it("is available off-platform (local development) without a key", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("HUBRIS_API_KEY", "");
    expect((await post()).status).toBe(200);
  });

  it("answers 503 when a check fails, so a deploy gate can key off the status", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "k");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    diag.report = {
      ok: false,
      gitVersion: null,
      steps: [{ step: "version", ok: false, ms: 1, code: "GIT_NOT_FOUND", detail: "spawn git ENOENT", hint: "No `git` executable on PATH" }],
      at: "x",
    };
    const res = await post({ "x-hubris-api-key": "k" });
    expect(res.status).toBe(503);
    expect((await res.json()).steps[0].code).toBe("GIT_NOT_FOUND");
  });

  it("caches briefly so it cannot be used to hammer the network", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "k");
    const h = { "x-hubris-api-key": "k" };
    expect((await (await post(h)).json()).cached).toBe(false);
    expect((await (await post(h)).json()).cached).toBe(true);
    expect((await (await post(h)).json()).cached).toBe(true);
    expect(diag.calls).toBe(1);
  });

  it("only accepts a plain https probe repository from configuration", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "k");
    vi.stubEnv("HUBRIS_GIT_PROBE_REPO", "https://u:p@github.com/x.git");
    await post({ "x-hubris-api-key": "k" });
    expect(diag.probeRepos[0]).toBe("https://github.com/octocat/Hello-World.git");
    resetGitDiagnosticsCache();
    vi.stubEnv("HUBRIS_GIT_PROBE_REPO", "https://github.com/kaiser1x/ts-js-dummy.git");
    await post({ "x-hubris-api-key": "k" });
    expect(diag.probeRepos[1]).toBe("https://github.com/kaiser1x/ts-js-dummy.git");
  });

  it("logs one outcome line with step names and codes only — no env values, tokens, or details", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    vi.stubEnv("GITHUB_TOKEN", "ghp_do_not_log_this_token_value");
    diag.report = {
      ok: false,
      gitVersion: null,
      steps: [{ step: "ls-remote", ok: false, ms: 9, code: "GIT_NETWORK", detail: "could not resolve host" }],
      at: "x",
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await post({ "x-hubris-api-key": "s3cret-value" });
    const logged = info.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("git diagnostics FAILED: ls-remote=GIT_NETWORK");
    expect(logged).not.toContain("s3cret-value");
    expect(logged).not.toContain("ghp_do_not_log_this_token_value");
    expect(logged).not.toContain("could not resolve host");
  });
});

describe("cold-start runtime check (one log line per function instance)", () => {
  const instance = (opts: Parameters<typeof coldStartGitCheck>[0]) => {
    resetColdStartCheck();
    const mini = new Hono();
    mini.use("*", coldStartGitCheck(opts));
    mini.get("/x", (c) => c.text("ok"));
    return mini;
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("logs success once, not per request", async () => {
    const log = vi.fn();
    const mini = instance({ enabled: () => true, probe: async () => ({ available: true, version: "2.45.1" }), log });
    await mini.request("/x");
    await mini.request("/x");
    await settle();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("info", "[hubris] runtime check: git 2.45.1 is available.");
  });

  it("logs an actionable error when git is missing, and still serves the request", async () => {
    const log = vi.fn();
    const mini = instance({ enabled: () => true, probe: async () => ({ available: false }), log });
    const res = await mini.request("/x");
    await settle();
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const [level, message] = log.mock.calls[0];
    expect(level).toBe("error");
    expect(message).toContain("no git binary");
    expect(message).toContain("POST /api/diagnostics/git");
  });

  it("a crashing probe is also reported as missing git, never thrown into the request", async () => {
    const log = vi.fn();
    const mini = instance({ enabled: () => true, probe: async () => { throw new Error("boom"); }, log });
    expect((await mini.request("/x")).status).toBe(200);
    await settle();
    expect(log.mock.calls[0][0]).toBe("error");
  });

  it("does nothing off-platform", async () => {
    const log = vi.fn();
    const probe = vi.fn(async () => ({ available: true as const, version: "x" }));
    const mini = instance({ enabled: () => false, probe, log });
    await mini.request("/x");
    await settle();
    expect(probe).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
