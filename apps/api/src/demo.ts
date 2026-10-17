// Public evaluator demo: the policy applied to anonymous traffic.
//
// The web app (the only holder of HUBRIS_API_KEY) marks every request from an
// anonymous visitor with `x-hubris-demo-session` (a per-browser id from an
// httpOnly cookie) and `x-hubris-demo-client` (a hash of the client address).
// Such a request is held to a narrow policy enforced HERE, server-side:
//
//   * one repository and branch (the known demo case), nothing else;
//   * only the routes the guided flow needs; SHIP and every other route that
//     writes or runs arbitrary work is refused;
//   * fixed sandbox commands (no free-form scripts, images, or refs);
//   * jobs are owned by the session that created them and invisible to others;
//   * per-session/per-client rate limits, a global concurrency cap and a daily
//     run budget, so anonymous use cannot exhaust model or sandbox credit.
//
// A request WITHOUT the demo header is an operator call (it still needs the
// API key) and is unaffected. Counters are in-memory: correct for the single
// long-lived API instance, reset on restart.

import type { Context, MiddlewareHandler } from "hono";
import { toSafeSandboxCloneUrl as toSafeCloneUrl } from "@hubris/sandbox";

export const DEMO_SESSION_HEADER = "x-hubris-demo-session";
export const DEMO_CLIENT_HEADER = "x-hubris-demo-client";

export const DEMO_REPO = "kaiser1x/ts-js-dummy";
export const DEMO_REPO_URL = "https://github.com/kaiser1x/ts-js-dummy.git";
export const DEMO_REF = "hubris/buggy-idempotency";
// Sandbox commands a demo visitor may run (Reproduce / Verify). Exact match.
export const DEMO_COMMANDS: readonly string[] = [
  "pnpm exec vitest run tests/payments.test.ts --reporter=verbose",
  "pnpm exec vitest run tests/payments.test.ts -t 'rejects duplicate idempotency keys'",
  "pnpm test",
];

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DemoLimits {
  // Analyses per session (and per client) per window.
  analyzePerWindow: number;
  // Model/sandbox runs per session per window; per client allows twice this.
  runsPerWindow: number;
  windowMs: number;
  // Demo requests doing model/sandbox/clone work at the same time, overall.
  maxConcurrent: number;
  // Model/sandbox runs across all demo visitors per UTC day.
  dailyRuns: number;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function demoLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): DemoLimits {
  return {
    analyzePerWindow: positiveInt(env.HUBRIS_DEMO_ANALYZE_PER_HOUR, 5),
    runsPerWindow: positiveInt(env.HUBRIS_DEMO_RUNS_PER_HOUR, 20),
    windowMs: 60 * 60 * 1000,
    maxConcurrent: positiveInt(env.HUBRIS_DEMO_MAX_CONCURRENT, 2),
    dailyRuns: positiveInt(env.HUBRIS_DEMO_DAILY_RUNS, 150),
  };
}

// The demo session a request carries: null = operator call; "invalid" = a
// demo header that is not a well-formed session id (rejected).
export function demoSessionOf(c: Context): string | null | "invalid" {
  const raw = c.req.header(DEMO_SESSION_HEADER);
  if (raw === undefined) return null;
  return SESSION_RE.test(raw) ? raw : "invalid";
}

// Owner check for a persisted job (result.demoSession, written by analyze).
export function jobOwnedBy(result: unknown, session: string): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { demoSession?: unknown }).demoSession === session
  );
}

type RouteKind = "analyze" | "run" | "read";
interface RoutePolicy {
  kind: RouteKind;
  // Validates the body for a demo request; returns an error message or null.
  checkBody?: (body: Record<string, unknown>) => string | null;
}

const NO_OVERRIDES = ["image", "ref", "manager", "verificationCommand", "instruction"] as const;

function forbidOverrides(body: Record<string, unknown>): string | null {
  const used = NO_OVERRIDES.filter((k) => body[k] !== undefined);
  return used.length > 0 ? `The demo does not accept ${used.join(", ")}.` : null;
}

function demoCommand(body: Record<string, unknown>): string | null {
  const script = typeof body.script === "string" ? body.script.trim() : "";
  return DEMO_COMMANDS.includes(script)
    ? forbidOverrides(body)
    : `The demo runs only these commands: ${DEMO_COMMANDS.join(" | ")}`;
}

const POLICIES: Record<string, RoutePolicy> = {
  "POST /api/analyze": {
    kind: "analyze",
    checkBody: (body) =>
      typeof body.repoUrl === "string" &&
      toSafeCloneUrl(body.repoUrl) === DEMO_REPO_URL &&
      body.ref === DEMO_REF
        ? null
        : `The public demo analyzes only ${DEMO_REPO} on branch ${DEMO_REF}.`,
  },
  "POST /api/investigate": { kind: "run", checkBody: forbidOverrides },
  "POST /api/reproduce": { kind: "run", checkBody: demoCommand },
  "POST /api/verify": { kind: "run", checkBody: demoCommand },
  "POST /api/forge-structured": {
    kind: "run",
    checkBody: (body) =>
      typeof body.investigationId === "string"
        ? forbidOverrides(body)
        : "The demo forges only from a READY investigation (investigationId is required).",
  },
  "GET /api/jobs": { kind: "read" },
  "GET /api/jobs/:id": { kind: "read" },
};

function routeKey(c: Context): string {
  const path = c.req.path.replace(/^\/api\/jobs\/[^/]+$/, "/api/jobs/:id");
  return `${c.req.method} ${path}`;
}

// ---- counters (single instance, in-memory) ----

const hits = new Map<string, number[]>();
let inFlight = 0;
const sessionsInFlight = new Set<string>();
let day = "";
let dayRuns = 0;

export function resetDemoState(): void {
  hits.clear();
  inFlight = 0;
  sessionsInFlight.clear();
  day = "";
  dayRuns = 0;
}

// Sliding-window limiter. Records the hit only when under the limit.
function allow(key: string, limit: number, windowMs: number, now: number): number | null {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return Math.ceil((windowMs - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(key, recent);
  return null;
}

function deny(c: Context, status: 400 | 403 | 404 | 429 | 503, code: string, error: string, retryAfterS?: number) {
  if (retryAfterS !== undefined) c.header("Retry-After", String(retryAfterS));
  return c.json({ error, code, status }, status);
}

export interface DemoGuardDeps {
  limits?: () => DemoLimits;
  // Loads a job's persisted result for the ownership check; undefined = no job.
  loadJobResult: (id: string) => Promise<unknown | undefined>;
  now?: () => number;
}

export function demoGuard(deps: DemoGuardDeps): MiddlewareHandler {
  const limitsOf = deps.limits ?? (() => demoLimitsFromEnv());
  const nowOf = deps.now ?? Date.now;
  return async (c, next) => {
    const session = demoSessionOf(c);
    if (session === null) return next();
    if (session === "invalid") {
      return deny(c, 400, "DEMO_SESSION_INVALID", "Demo session is missing or invalid. Reload the page to start a new one.");
    }
    const key = routeKey(c);
    if (key === "POST /api/ship") {
      return deny(
        c,
        403,
        "DEMO_SHIP_DISABLED",
        "The public demo does not open pull requests. The verified patch and its provenance are shown instead; shipping requires an authenticated operator."
      );
    }
    const policy = POLICIES[key];
    if (!policy) {
      return deny(c, 403, "DEMO_ROUTE_DISABLED", "This action is not part of the public demo.");
    }

    let body: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        // Hono caches the parsed body; the route handler reads it again.
        const parsed = await c.req.json();
        body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        return deny(c, 400, "DEMO_BAD_REQUEST", "Invalid JSON body");
      }
      const problem = policy.checkBody?.(body) ?? null;
      if (problem) return deny(c, 403, "DEMO_RESTRICTED", problem);
    }

    // Ownership: a demo session sees and acts on its own jobs only. Unknown
    // and foreign jobs are indistinguishable (404) so ids cannot be probed.
    const jobId = key === "GET /api/jobs/:id" ? c.req.path.split("/").pop() : body.jobId;
    if (key !== "GET /api/jobs" && key !== "POST /api/analyze") {
      if (typeof jobId !== "string" || jobId.length === 0) {
        return deny(c, 400, "DEMO_BAD_REQUEST", "jobId is required");
      }
      const result = await deps.loadJobResult(jobId);
      if (result === undefined || !jobOwnedBy(result, session)) {
        return deny(c, 404, "DEMO_JOB_NOT_FOUND", "Job not found in this demo session. Start the demo again to create one.");
      }
    }

    if (policy.kind === "read") return next();

    const limits = limitsOf();
    const now = nowOf();
    const client = c.req.header(DEMO_CLIENT_HEADER) ?? session;
    const [bucket, perSession, perClient] =
      policy.kind === "analyze"
        ? ["analyze", limits.analyzePerWindow, limits.analyzePerWindow * 2]
        : ["run", limits.runsPerWindow, limits.runsPerWindow * 2];
    if (sessionsInFlight.has(session)) {
      return deny(c, 429, "DEMO_BUSY_SESSION", "A demo step is already running for this session. Wait for it to finish.", 10);
    }
    if (inFlight >= limits.maxConcurrent) {
      return deny(c, 503, "DEMO_BUSY", "The demo is busy with other evaluators. Try again in a minute.", 60);
    }
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dayRuns = 0;
    }
    if (policy.kind === "run" && dayRuns >= limits.dailyRuns) {
      return deny(c, 503, "DEMO_BUDGET_EXHAUSTED", "Today's demo run budget is used up. Try again tomorrow (UTC).");
    }
    const waitS =
      allow(`s:${bucket}:${session}`, perSession, limits.windowMs, now) ??
      allow(`c:${bucket}:${client}`, perClient, limits.windowMs, now);
    if (waitS !== null) {
      return deny(c, 429, "DEMO_RATE_LIMITED", `Demo rate limit reached. Try again in ${waitS}s.`, waitS);
    }

    if (policy.kind === "run") dayRuns += 1;
    inFlight += 1;
    sessionsInFlight.add(session);
    try {
      await next();
    } finally {
      inFlight -= 1;
      sessionsInFlight.delete(session);
    }
  };
}
