import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiAuthHeaders } from "../lib/api-auth";

// The web app is a thin server-side proxy to the HUBRIS API. When the API is
// deployed as its own (public) Vercel project it is gated by HUBRIS_API_KEY, so
// every proxy must attach it — server-side only.

const WEB = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiAuthHeaders", () => {
  it("adds nothing when no key is configured (local development)", () => {
    vi.stubEnv("HUBRIS_API_KEY", "");
    expect(apiAuthHeaders()).toEqual({});
  });

  it("sends the key in the header the API checks", () => {
    vi.stubEnv("HUBRIS_API_KEY", "s3cret-value");
    expect(apiAuthHeaders()).toEqual({ "x-hubris-api-key": "s3cret-value" });
  });
});

describe("proxy routes", () => {
  const routes = walk(join(WEB, "app", "api")).filter((f) => f.endsWith("route.ts"));

  it("finds the proxies", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(routes.map((f) => [f.slice(WEB.length), f] as const))("%s forwards the API key on every upstream call", (_name, file) => {
    const source = readFileSync(file, "utf8");
    const upstreamCalls = (source.match(/fetch\(/g) ?? []).length;
    const authSpreads = (source.match(/\.\.\.apiAuthHeaders\(\)/g) ?? []).length;
    expect(upstreamCalls).toBeGreaterThan(0);
    expect(authSpreads).toBe(upstreamCalls);
    expect(source).toContain('from "');
    expect(source).toMatch(/lib\/api-auth"/);
  });
});

describe("secrets stay server-side", () => {
  it("no secret-bearing variable is exposed through NEXT_PUBLIC in the web app", () => {
    const offenders = walk(WEB)
      .filter((f) => /\.(ts|tsx|mjs|js|json|env.*)$/.test(f) && !f.includes(`${join("test", "")}`) && !f.endsWith("package.json"))
      .filter((f) => /NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET|DATABASE|NEBIUS|PASSWORD)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(WEB.length))).toEqual([]);
  });

  it("HUBRIS_API_KEY is only read in the server-side helper", () => {
    const readers = walk(join(WEB, "app"))
      .concat(walk(join(WEB, "lib")))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("HUBRIS_API_KEY"))
      .map((f) => f.slice(WEB.length).replace(/\\/g, "/"));
    expect(readers).toEqual(["lib/api-auth.ts"]);
  });

  it("client components never import the auth helper", () => {
    const clientFiles = walk(join(WEB, "app")).filter(
      (f) => /\.(ts|tsx)$/.test(f) && /^\s*["']use client["']/.test(readFileSync(f, "utf8"))
    );
    for (const f of clientFiles) expect(readFileSync(f, "utf8"), f).not.toContain("api-auth");
  });
});
