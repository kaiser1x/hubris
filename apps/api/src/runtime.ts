// Runtime concerns that only matter when the API runs as a platform function
// (Vercel) instead of a long-lived Node process:
//
//   * a per-request TIME BUDGET. A function is killed at its maximum duration
//     with a bare 504, which loses the evidence a run was about to persist.
//     Every sandbox wait and model call is therefore clamped to what is left of
//     the budget, so a slow run ends as a normal TIMEOUT/error that HUBRIS
//     records and reports, not as a platform kill.
//   * an opt-in API key for the public deployment.
//   * a readiness probe for the capabilities the platform may not provide
//     (a `git` binary, a reachable database).
//
// Locally (no VERCEL, no HUBRIS_FUNCTION_MAX_DURATION_S) nothing is clamped and
// behavior is exactly what it was.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { runCommand } from "@hubris/sandbox";
import { describeRuntimeGit } from "./gitdiag";

const execFileAsync = promisify(execFile);

// Vercel's default (and the Hobby maximum) with Fluid compute. Set
// HUBRIS_FUNCTION_MAX_DURATION_S to the same value as the project's "Default
// Max Duration" (up to 800 on Pro/Enterprise).
export const VERCEL_DEFAULT_MAX_DURATION_S = 300;
// Time kept back for persisting evidence and writing the response.
export const FUNCTION_RESERVE_MS = 15_000;
// The sandbox must kill a command before our poll gives up on it, otherwise the
// run is abandoned instead of reported as timed out.
export const COMMAND_MARGIN_S = 5;
const MIN_WAIT_MS = 1_000;
// Starting a sandbox run (upload, install, verify) with less time than this
// left cannot produce evidence; the request fails before any side effect.
export const MIN_SANDBOX_BUDGET_MS = 60_000;
const SANDBOX_DEFAULT_WAIT_MS = 120_000;

// The function's maximum duration in ms, or null when there is no platform
// limit to respect (local Node server, tests).
export function functionMaxDurationMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const configured = Number(env.HUBRIS_FUNCTION_MAX_DURATION_S);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured) * 1000;
  if (env.VERCEL) return VERCEL_DEFAULT_MAX_DURATION_S * 1000;
  return null;
}

interface RequestScope {
  startedAt: number;
}
const scope = new AsyncLocalStorage<RequestScope>();

// Time left for useful work in this request; null = unbounded. Outside a
// request scope (scripts, tests) it is unbounded.
export function remainingBudgetMs(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): number | null {
  const max = functionMaxDurationMs(env);
  const store = scope.getStore();
  if (max === null || !store) return null;
  return Math.max(0, max - FUNCTION_RESERVE_MS - (now - store.startedAt));
}

// Hono middleware: starts the request's clock.
export function requestBudget(): MiddlewareHandler {
  return (_c, next) => scope.run({ startedAt: Date.now() }, next);
}

// A model-call abort signal that never outlives the request's budget.
export function budgetSignal(ms: number): AbortSignal {
  const remaining = remainingBudgetMs();
  return AbortSignal.timeout(remaining === null ? ms : Math.max(1, Math.min(ms, remaining)));
}

type SandboxRequest = Parameters<typeof runCommand>[1];

// Fit a sandbox request to the time left. Pure; exported for tests.
export function fitSandboxRequest<T extends { timeout?: number; waitMs?: number }>(
  req: T,
  remainingMs: number | null
): T {
  if (remainingMs === null) return req;
  const requestedWait = req.waitMs ?? SANDBOX_DEFAULT_WAIT_MS;
  const waitMs = Math.max(MIN_WAIT_MS, Math.min(requestedWait, remainingMs));
  if (waitMs >= requestedWait) return req;
  // Server-side command timeout fires BEFORE the poll budget runs out, so the
  // run comes back as a clean `timedOut` result that callers already persist.
  const ceilingS = Math.max(1, Math.floor(waitMs / 1000) - COMMAND_MARGIN_S);
  const timeout = Math.max(1, Math.min(req.timeout ?? ceilingS, ceilingS));
  return { ...req, waitMs, timeout };
}

// Drop-in replacement for the sandbox client's runCommand.
export function runCommandWithinBudget(
  config: Parameters<typeof runCommand>[0],
  req: SandboxRequest
): ReturnType<typeof runCommand> {
  return runCommand(config, fitSandboxRequest(req, remainingBudgetMs()));
}

// ---- opt-in API key ----

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// When HUBRIS_API_KEY is set, every route except /health requires it in the
// `x-hubris-api-key` header. Unset (local development) = open, as before. The
// web app's server-side proxies add the header; the key is never sent to a
// browser and never read from a NEXT_PUBLIC variable.
export function apiKeyGuard(): MiddlewareHandler {
  return async (c: Context, next) => {
    const expected = process.env.HUBRIS_API_KEY;
    if (!expected || c.req.path === "/health") return next();
    const provided = c.req.header("x-hubris-api-key") ?? "";
    if (!sameSecret(provided, expected)) {
      return c.json({ error: "Unauthorized", status: 401 }, 401);
    }
    return next();
  };
}

// ---- readiness ----

export interface ReadinessReport {
  status: "ready" | "degraded";
  checks: {
    database: "ok" | "not-configured" | "error";
    git: { available: boolean; version?: string };
    sandbox: boolean;
    llm: boolean;
    github: boolean;
  };
  runtime: { platform: "vercel" | "node"; functionMaxDurationS: number | null };
}

// Once per function instance, on its first request: log whether git works in
// THIS runtime (the deployed function image, not the build container). Never
// blocks the request, never logs environment values, tokens, or paths.
let coldStartLogged = false;
export function resetColdStartCheck(): void {
  coldStartLogged = false;
}

export function coldStartGitCheck(
  deps: { probe?: typeof probeGit; log?: (level: "info" | "error", message: string) => void; enabled?: () => boolean } = {}
): MiddlewareHandler {
  const probe = deps.probe ?? probeGit;
  const log = deps.log ?? ((level, message) => (level === "error" ? console.error(message) : console.info(message)));
  const enabled = deps.enabled ?? (() => Boolean(process.env.VERCEL));
  return async (_c, next) => {
    if (!coldStartLogged && enabled()) {
      coldStartLogged = true;
      void probe()
        .then((result) => {
          const line = describeRuntimeGit(result);
          log(line.level, line.message);
        })
        .catch(() => log("error", describeRuntimeGit({ available: false }).message));
    }
    await next();
  };
}

export async function probeGit(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5000 });
    return { available: true, version: stdout.trim().replace(/^git version\s+/, "") };
  } catch {
    return { available: false };
  }
}

// Capability report. Booleans and a git version only — never a value.
export async function readiness(deps: {
  databaseCheck: () => Promise<"ok" | "not-configured" | "error">;
  env?: NodeJS.ProcessEnv;
  gitProbe?: typeof probeGit;
}): Promise<ReadinessReport> {
  const env = deps.env ?? process.env;
  const [database, git] = await Promise.all([deps.databaseCheck(), (deps.gitProbe ?? probeGit)()]);
  const maxMs = functionMaxDurationMs(env);
  const checks = {
    database,
    git,
    sandbox: Boolean(env.NEBIUS_API_KEY && env.NEBIUS_PROJECT_ID),
    llm: Boolean(env.NEBIUS_API_KEY && env.NEBIUS_MODEL),
    github: Boolean(env.GITHUB_TOKEN?.trim()),
  };
  return {
    status: database === "ok" && git.available ? "ready" : "degraded",
    checks,
    runtime: { platform: env.VERCEL ? "vercel" : "node", functionMaxDurationS: maxMs === null ? null : maxMs / 1000 },
  };
}

// ---- event-loop stall diagnostics (long-lived server) ----
//
// /health does no I/O, so a health check that times out means the event loop
// was blocked (CPU-bound work in a request) or the process was gone. This
// watchdog makes a stall visible in the service log together with the
// requests in flight at the time: method and path only — never query
// strings, headers, bodies or environment values.

const inFlight = new Map<number, string>();
let inFlightSeq = 0;

export function trackInFlight(): MiddlewareHandler {
  return async (c, next) => {
    const id = ++inFlightSeq;
    inFlight.set(id, `${c.req.method} ${c.req.path}`);
    try {
      await next();
    } finally {
      inFlight.delete(id);
    }
  };
}

export function inFlightRequests(): string[] {
  return [...inFlight.values()];
}

export function watchEventLoop(
  options: { intervalMs?: number; thresholdMs?: number; log?: (message: string) => void; now?: () => number } = {}
): () => void {
  const intervalMs = options.intervalMs ?? 500;
  const thresholdMs = options.thresholdMs ?? 1000;
  const log = options.log ?? ((m: string) => console.warn(m));
  const now = options.now ?? Date.now;
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const lag = t - last - intervalMs;
    last = t;
    if (lag >= thresholdMs) {
      const active = inFlightRequests();
      log(`[hubris] event loop blocked ~${lag}ms; in flight: ${active.length > 0 ? active.join(", ") : "none"}`);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
