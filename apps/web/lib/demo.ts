// Public evaluator demo — web side (server-only).
//
// In demo mode every API call the web server makes on behalf of a visitor is
// marked with that visitor's demo session (an httpOnly cookie set by
// proxy.ts) and a hash of the client address. The API then applies the demo
// policy (apps/api/src/demo.ts): one repository/branch, owned jobs only,
// fixed commands, no SHIP, rate and concurrency limits. Anonymous visitors
// can therefore never make an operator call, even though the web server holds
// the API key.
//
// Demo mode is ON by default on Vercel (the public site) and OFF locally.
// HUBRIS_DEMO_MODE=on|off overrides either way.

import { createHash } from "node:crypto";

export const DEMO_COOKIE = "hubris_demo_session";
export const DEMO_SESSION_HEADER = "x-hubris-demo-session";
export const DEMO_CLIENT_HEADER = "x-hubris-demo-client";
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Env = Readonly<Record<string, string | undefined>>;

export function isDemoMode(env: Env = process.env): boolean {
  const flag = env.HUBRIS_DEMO_MODE?.trim().toLowerCase();
  if (flag === "on" || flag === "1" || flag === "true") return true;
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return Boolean(env.VERCEL);
}

export function isDemoSessionId(value: string | undefined | null): value is string {
  return typeof value === "string" && SESSION_RE.test(value);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Stable, non-reversible client key for per-address limits (the raw address
// is never forwarded).
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`hubris-demo:${address}`).digest("hex").slice(0, 32);
}

// Headers that put an API call under the demo policy. In demo mode they are
// ALWAYS present: a request without a valid session cookie is sent with an
// invalid marker, which the API rejects — never as an operator call.
export function demoHeaders(request: Request | undefined, env: Env = process.env): Record<string, string> {
  if (!isDemoMode(env)) return {};
  const session = request ? readCookie(request, DEMO_COOKIE) : null;
  return {
    [DEMO_SESSION_HEADER]: isDemoSessionId(session) ? session : "missing",
    [DEMO_CLIENT_HEADER]: request ? clientKey(request) : "unknown",
  };
}
