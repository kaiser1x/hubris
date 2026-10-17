import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { apiAuthHeaders } from "../lib/api-auth";
import { DEMO_COOKIE, demoHeaders, isDemoMode } from "../lib/demo";
import { proxy } from "../proxy";
import { GET as demoStatus, POST as demoReset } from "../app/api/demo/route";
import { POST as analyzePost } from "../app/api/analyze/route";
import { DEMO_CASE, demoProgress, readDemoReply } from "../app/lib/demo-case";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SESSION = "11111111-1111-4111-8111-111111111111";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const src = (rel: string) => readFileSync(join(WEB, rel), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("demo mode", () => {
  it("is on by default on Vercel (the public site) and off locally; overridable", () => {
    expect(isDemoMode({ VERCEL: "1" })).toBe(true);
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ VERCEL: "1", HUBRIS_DEMO_MODE: "off" })).toBe(false);
    expect(isDemoMode({ HUBRIS_DEMO_MODE: "on" })).toBe(true);
  });
});

describe("every API call from a demo visitor carries the demo session", () => {
  const withCookie = (cookie: string | null, ip = "203.0.113.7") =>
    new Request("https://hubris.example/api/jobs", {
      headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": `${ip}, 10.0.0.1` },
    });

  it("forwards a valid session and a hashed client key (never the raw address)", () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    const h = demoHeaders(withCookie(`${DEMO_COOKIE}=${SESSION}`));
    expect(h["x-hubris-demo-session"]).toBe(SESSION);
    expect(h["x-hubris-demo-client"]).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(h)).not.toContain("203.0.113.7");
  });

  it("a missing or forged cookie is still sent as a demo call (rejected by the API), never as an operator call", () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    expect(demoHeaders(withCookie(null))["x-hubris-demo-session"]).toBe("missing");
    expect(demoHeaders(withCookie(`${DEMO_COOKIE}=../../admin`))["x-hubris-demo-session"]).toBe("missing");
    expect(demoHeaders(undefined)["x-hubris-demo-session"]).toBe("missing");
  });

  it("apiAuthHeaders combines the server key with the demo session; nothing in local mode", () => {
    vi.stubEnv("HUBRIS_API_KEY", "server-key");
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    const h = apiAuthHeaders(withCookie(`${DEMO_COOKIE}=${SESSION}`));
    expect(h["x-hubris-api-key"]).toBe("server-key");
    expect(h["x-hubris-demo-session"]).toBe(SESSION);
    vi.stubEnv("HUBRIS_DEMO_MODE", "off");
    expect(apiAuthHeaders(withCookie(`${DEMO_COOKIE}=${SESSION}`))).toEqual({ "x-hubris-api-key": "server-key" });
  });

  it("a proxy route sends the visitor's session upstream (end-to-end through the route handler)", async () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    let sent: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = init.headers as Record<string, string>;
        return Response.json({ jobId: "j" });
      })
    );
    await analyzePost(
      new Request("https://hubris.example/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${DEMO_COOKIE}=${SESSION}` },
        body: JSON.stringify({ repoUrl: DEMO_CASE.repoUrl, ref: DEMO_CASE.ref }),
      })
    );
    expect(sent["x-hubris-demo-session"]).toBe(SESSION);
  });
});

describe("demo session cookie (proxy.ts)", () => {
  it("issues a private httpOnly session to a new visitor and scopes the same request to it", () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    const res = proxy(new NextRequest("https://hubris.example/api/jobs"));
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(new RegExp(`${DEMO_COOKIE}=[0-9a-f-]{36}`));
    expect(set.toLowerCase()).toContain("httponly");
    expect(set.toLowerCase()).toContain("samesite=lax");
    // Forwarded to the route handler for this same request.
    expect(res.headers.get("x-middleware-request-cookie") ?? "").toContain(DEMO_COOKIE);
  });

  it("keeps an existing valid session and replaces a forged one", () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    const keep = proxy(new NextRequest("https://hubris.example/api/jobs", { headers: { cookie: `${DEMO_COOKIE}=${SESSION}` } }));
    expect(keep.headers.get("set-cookie")).toBeNull();
    const forged = proxy(new NextRequest("https://hubris.example/api/jobs", { headers: { cookie: `${DEMO_COOKIE}=admin` } }));
    expect(forged.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${DEMO_COOKIE}=[0-9a-f-]{36}`));
  });

  it("does nothing outside demo mode", () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "off");
    expect(proxy(new NextRequest("https://hubris.example/api/jobs")).headers.get("set-cookie")).toBeNull();
  });

  it("START AGAIN issues a fresh session; status reveals only a boolean", async () => {
    vi.stubEnv("HUBRIS_DEMO_MODE", "on");
    const res = await demoReset();
    expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${DEMO_COOKIE}=[0-9a-f-]{36}.*HttpOnly`, "i"));
    expect(await (await demoStatus()).json()).toEqual({ demo: true });
  });
});

describe("secrets never reach browser code", () => {
  const clientFiles = walk(join(WEB, "app")).filter(
    (f) => /\.(ts|tsx)$/.test(f) && /^\s*["']use client["']/.test(readFileSync(f, "utf8"))
  );

  it("client components import neither the server key helper nor the server demo module", () => {
    for (const f of clientFiles) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toContain("api-auth");
      expect(s, f).not.toMatch(/lib\/demo"/);
    }
  });

  it("no browser-reachable file names a server secret", () => {
    const browserSide = [...clientFiles, join(WEB, "app", "lib", "demo-case.ts")];
    for (const f of browserSide) {
      const s = readFileSync(f, "utf8");
      for (const secret of ["HUBRIS_API_KEY", "DATABASE_URL", "NEBIUS_API_KEY", "GITHUB_TOKEN"]) {
        expect(s, `${f} mentions ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe("guided progress shows only persisted evidence", () => {
  it("a fresh job: analysis done, everything else to do", () => {
    const steps = demoProgress({
      id: "j1",
      status: "complete",
      result: { commitSha: "256e395f8df8e345f647b43fb1a97bb2011b9672", stats: { functions: 23, tests: 3, endpoints: 3, relationships: 91 } },
    });
    expect(steps.map((s) => s.key)).toEqual(["understand", "trace", "investigate", "reproduce", "forge", "verify", "ship"]);
    expect(steps[0]).toMatchObject({ state: "done", evidence: "23 functions, 3 tests, 3 endpoints @ 256e395" });
    expect(steps.slice(2).every((s) => s.state === "pending" && s.evidence === null)).toBe(true);
    expect(steps[2].href).toBe("/investigate?jobId=j1&demo=1");
  });

  it("reports the recorded outcomes, including failures, verbatim", () => {
    const steps = demoProgress({
      id: "j1",
      status: "complete",
      result: {
        stats: { functions: 1, tests: 1, endpoints: 0, relationships: 0 },
        investigationRuns: [{ investigationId: "inv-123456789", status: "READY" }],
        reproductions: [{ outcome: "NOT_REPRODUCED" }],
        forgeRuns: [
          {
            id: "run-1",
            status: "VERIFIED",
            stdout: " Tests  13 passed (13)\n",
            verification: {
              command: "pnpm test",
              exitCode: 0,
              timedOut: false,
              passed: true,
              assessment: { state: "REPAIR_VERIFIED", patchApplied: true, targetVerificationPassed: true, fullSuitePassed: true, unrelatedTestFailures: 0, failedTests: [] },
            },
          },
        ],
      },
    });
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.investigate).toMatchObject({ state: "done", evidence: "READY · inv-1234" });
    expect(by.reproduce).toMatchObject({ state: "failed", evidence: "NOT_REPRODUCED" });
    expect(by.reproduce.href).toContain("investigationId=inv-123456789");
    expect(by.forge).toMatchObject({ state: "done", evidence: "VERIFIED · 13/13 tests passed" });
    expect(by.verify).toMatchObject({ state: "done", evidence: "target test passed · full suite passed · 13/13" });
    expect(by.ship.href).toContain("forgeRunId=run-1");
  });

  it("verify is never 'done' unless the target test itself passed", () => {
    const steps = demoProgress({
      id: "j1",
      status: "complete",
      result: {
        stats: { functions: 1, tests: 1, endpoints: 0, relationships: 0 },
        forgeRuns: [
          {
            id: "r",
            status: "VERIFIED",
            verification: {
              command: "pnpm test",
              exitCode: 0,
              timedOut: false,
              passed: true,
              assessment: { state: "FULL_SUITE_PASSED", patchApplied: true, targetVerificationPassed: null, fullSuitePassed: true, unrelatedTestFailures: 0, failedTests: [] },
            },
          },
        ],
      },
    });
    expect(steps.find((s) => s.key === "verify")).toMatchObject({ state: "failed", evidence: "target test not run · full suite passed" });
  });

  it("never throws on garbage", () => {
    expect(() => demoProgress(null)).not.toThrow();
    expect(demoProgress({ result: "x" }).every((s) => s.state !== "done")).toBe(true);
  });
});

describe("actionable errors and timeouts", () => {
  it("passes the server's demo refusal through", () => {
    const out = readDemoReply(403, JSON.stringify({ error: "The public demo analyzes only kaiser1x/ts-js-dummy…", code: "DEMO_RESTRICTED" }));
    expect(out).toEqual({ ok: false, error: "The public demo analyzes only kaiser1x/ts-js-dummy…", code: "DEMO_RESTRICTED" });
  });

  it("a platform 504 page becomes a timeout message; 429 without body is explained", () => {
    const t = readDemoReply(504, "<html>FUNCTION_INVOCATION_TIMEOUT</html>");
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toMatch(/timed out/);
    const r = readDemoReply(429, "");
    if (!r.ok) expect(r.error).toMatch(/Too many/);
  });

  it("the demo page bounds every request, never parses with res.json(), and offers START AGAIN", () => {
    const page = src("app/(workspace)/demo/page.tsx");
    expect(page).toContain("AbortSignal.timeout(timeoutMs)");
    expect(page).not.toMatch(/res\.json\(\)/);
    expect(page).toContain("START AGAIN");
    expect(page).toContain("How this demo works");
    expect(page).toMatch(/role="alert"/);
  });
});

describe("entry point and SHIP in the UI", () => {
  it("the landing page has a prominent Try Demo entry", () => {
    const landing = src("app/page.tsx");
    expect(landing).toContain('href="/demo"');
    expect(landing).toContain("TRY DEMO");
  });

  it("the Ship page disables PR creation in demo mode and explains why", () => {
    const ship = src("app/(workspace)/ship/page.tsx");
    expect(ship).toContain('fetch("/api/demo")');
    expect(ship).toContain("disabled={!eligibility.eligible || demoMode}");
    expect(ship).toContain("data-demo-ship-disabled");
  });
});

describe("sandbox/model proxies end with an explicit timeout, not a platform kill", () => {
  it.each(["reproduce", "verify", "investigate"])("/api/%s aborts upstream before maxDuration and answers 504 JSON", async (name) => {
    const mod = (await import(`../app/api/${name}/route`)) as { POST: (r: Request) => Promise<Response>; maxDuration: number };
    expect(mod.maxDuration).toBe(300);
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        throw new DOMException("timed out", "TimeoutError");
      })
    );
    const res = await mod.POST(
      new Request(`https://hubris.example/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(res.status).toBe(504);
    expect(((await res.json()) as { code: string }).code).toBe("UPSTREAM_TIMEOUT");
  });
});
