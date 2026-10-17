import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "url";

// Liveness vs readiness, and liveness under load. Hermetic: the job store and
// git clone are mocked; the REAL analyzer runs on a generated repository.

const ctx = vi.hoisted(() => ({
  db: "none" as "none" | "hang" | "fail" | "ok",
  repoFiles: 0,
  jobs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify: p } = await import("util");
  const fsm = await import("fs");
  const pathm = await import("path");
  const fake = (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "clone") {
      const dest = args[args.length - 1];
      if (ctx.repoFiles > 0) {
        for (let i = 0; i < ctx.repoFiles; i++) {
          const dir = pathm.join(dest, "src", `m${i % 8}`);
          fsm.mkdirSync(dir, { recursive: true });
          fsm.writeFileSync(
            pathm.join(dir, `f${i}.ts`),
            `export function f${i}(a: number): number {\n  if (a > ${i}) throw new Error("big");\n  return [a].map((x) => x + 1)[0];\n}\n`
          );
        }
        fsm.writeFileSync(pathm.join(dest, "package.json"), "{}");
      } else {
        fsm.cpSync(fileURLToPath(new URL("../../../fixtures/ts-js-dummy", import.meta.url)), dest, { recursive: true });
      }
      return { stdout: "", stderr: "" };
    }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: `${"7".repeat(40)}\n`, stderr: "" };
    if (cmd === "git" && args[0] === "--version") return { stdout: "git version 2.45.0\n", stderr: "" };
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
  function execFile(cmd: string, args: string[], _o: unknown, cb?: (e: Error | null, o?: string, e2?: string) => void) {
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

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  const never = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    getDb: () => {
      if (ctx.db === "none") return null;
      return {
        execute: () => (ctx.db === "hang" ? never() : ctx.db === "fail" ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve([])),
        select: () => ({
          from: () => ({
            where: () => (ctx.db === "hang" ? never() : Promise.resolve([...ctx.jobs.values()])),
          }),
        }),
        insert: () => ({
          values: async (v: { id: string }) => {
            if (ctx.db === "hang") return never();
            ctx.jobs.set(v.id, { ...v });
          },
        }),
        update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void Object.assign([...ctx.jobs.values()].at(-1) ?? {}, v) }) }),
      };
    },
  };
});

import { app } from "../src/app";
import { inFlightRequests, watchEventLoop } from "../src/runtime";
import { startServer } from "../src/local";

beforeEach(() => {
  ctx.db = "none";
  ctx.repoFiles = 0;
  ctx.jobs.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// Resolves to "timeout" if the request does not answer within `ms`. A generous
// bound: the point is "does not hang", not a latency benchmark.
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

describe("GET /health is pure liveness", () => {
  it("answers 200 without touching the database, git, or any integration", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "hubris-api" });
  });

  it("stays fast when the database hangs", async () => {
    ctx.db = "hang";
    const res = await within(app.request("/health"), 1000);
    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(200);
  });

  it("is reachable without the API key; every other route still requires it", async () => {
    vi.stubEnv("HUBRIS_API_KEY", "server-key");
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/ready")).status).toBe(401);
    expect((await app.request("/api/jobs")).status).toBe(401);
  });
});

describe("GET /ready reports dependencies without hanging", () => {
  it("a hung database is reported as an error after the bounded timeout (503), not a hang", async () => {
    ctx.db = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const pending = app.request("/ready");
    await vi.advanceTimersByTimeAsync(3_100);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: { database: string } }).checks.database).toBe("error");
  });

  it("a refused connection is reported as an error (503), never as ready", async () => {
    ctx.db = "fail";
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: { database: string } }).checks.database).toBe("error");
  });
});

describe("liveness while the API is busy", () => {
  it("answers /health promptly while a large repository is being analyzed on the same process", async () => {
    ctx.db = "ok";
    ctx.repoFiles = 800;
    const started = Date.now();
    let done = false;
    // A real health check arrives on the socket and waits for the event loop.
    // Model that: a probe every 5ms; the gap between probes is how long a
    // check would have waited. Each probe also calls /health for real.
    const ticks: number[] = [Date.now()];
    const pending: Array<Promise<Response>> = [];
    const probe = setInterval(() => {
      if (done) return;
      ticks.push(Date.now());
      pending.push(app.request("/health"));
    }, 5);
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/acme/big" }),
    });
    done = true;
    clearInterval(probe);
    ticks.push(Date.now());
    const total = Date.now() - started;
    expect(res.status).toBe(200);
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
    const worstWait = Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]));
    // Relative, not a machine-specific number: a blocked event loop makes a
    // check wait for (nearly) the whole analysis; a cooperative one answers
    // within a small fraction of it.
    expect(worstWait).toBeLessThan(total * 0.25);
  }, 60_000);

  it("refuses a repository over the file limit with 413 and marks the job failed", async () => {
    ctx.db = "ok";
    ctx.repoFiles = 30;
    vi.stubEnv("HUBRIS_MAX_REPO_FILES", "20");
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/acme/big" }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("REPO_TOO_LARGE");
    expect(body.error).toMatch(/more than 20 source files/);
    expect([...ctx.jobs.values()].at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("failures stay observable", () => {
  it("logs an event-loop stall with the in-flight requests (method + path only)", () => {
    let t = 0;
    const logs: string[] = [];
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const stop = watchEventLoop({ intervalMs: 500, thresholdMs: 1000, log: (m) => logs.push(m), now: () => t });
    t = 500;
    vi.advanceTimersByTime(500); // on time: no log
    t = 3500;
    vi.advanceTimersByTime(500); // 2.5s late: stall
    stop();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/event loop blocked ~2500ms; in flight: none/);
    expect(inFlightRequests()).toEqual([]);
  });

  it("binds Render's PORT on all interfaces", () => {
    let bound: { port: number; hostname: string } | null = null;
    startServer({
      env: { PORT: "10000" } as NodeJS.ProcessEnv,
      serveFn: (o) => {
        bound = { port: o.port, hostname: o.hostname };
        return new EventEmitter();
      },
      watch: () => undefined,
      log: () => undefined,
    });
    expect(bound).toEqual({ port: 10000, hostname: "0.0.0.0" });
  });

  it("a listener that cannot bind exits non-zero with the reason", () => {
    const server = new EventEmitter();
    const exit = vi.fn();
    const errors: string[] = [];
    startServer({ env: {} as NodeJS.ProcessEnv, serveFn: () => server, exit, error: (m) => errors.push(m), watch: () => undefined, log: () => undefined });
    server.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors[0]).toBe("[hubris] server failed to start: EADDRINUSE");
  });
});
