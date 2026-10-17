import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { llmConfigFromEnv } from "@hubris/llm";
import { sandboxConfigFromEnv } from "@hubris/sandbox";
import { closeDb, getDb } from "@hubris/db";
import appDefault, { app } from "../src/app";
import { githubTokenFromEnv } from "../src/ship";

// Vercel runs the DEFAULT EXPORT of a recognized entry file as the function
// (https://vercel.com/docs/frameworks/backend/hono). These tests pin that
// contract so the local Node server and the Vercel function cannot drift apart.

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${API_DIR}${rel}`, "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Vercel entrypoint", () => {
  it("src/app.ts default-exports the Hono app (and still exports it by name)", () => {
    expect(appDefault).toBe(app);
    expect(typeof appDefault.fetch).toBe("function");
  });

  it("the entry file imports hono and has a default export (Vercel's detection rule)", () => {
    const source = read("src/app.ts");
    expect(source).toMatch(/from "hono"/);
    expect(source).toMatch(/^export default app;$/m);
  });

  it("the entry never starts a server or loads a .env file", () => {
    const source = read("src/app.ts");
    expect(source).not.toContain("@hono/node-server");
    expect(source).not.toMatch(/\bserve\(/);
    expect(source).not.toMatch(/\.listen\(/);
    expect(source).not.toContain("dotenv");
  });

  it("the local Node server is a separate file that owns dotenv + serve", () => {
    const local = read("src/local.ts");
    expect(local).toContain("@hono/node-server");
    expect(local).toContain("dotenv");
    expect(local).toMatch(/serve\(/);
    expect(local).toMatch(/import \{ app \} from "\.\/app"/);
    // Nothing else may pull the server or dotenv into the function bundle.
    for (const file of readdirSync(`${API_DIR}src`).filter((f) => f.endsWith(".ts") && f !== "local.ts")) {
      const text = read(`src/${file}`);
      expect(text, file).not.toContain("@hono/node-server");
      expect(text, file).not.toContain('from "dotenv"');
    }
  });

  it("no second file competes as a Vercel entrypoint", () => {
    const candidates = ["app", "index", "server"].flatMap((n) =>
      ["js", "cjs", "mjs", "ts", "cts", "mts"].flatMap((e) => [`${n}.${e}`, `src/${n}.${e}`])
    );
    const present = candidates.filter((rel) => existsSync(`${API_DIR}${rel}`));
    expect(present).toEqual(["src/app.ts"]);
  });

  it("dev/start run the local server entry, not the function entry", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toBe("node dist/local.js");
    expect(pkg.scripts.start).toBe("node dist/local.js");
    expect(JSON.stringify(pkg.scripts)).not.toContain("dist/index.js");
  });
});

describe("routing through the default export (what Vercel invokes)", () => {
  it("serves /health", async () => {
    const res = await appDefault.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "hubris-api" });
  });

  it("keeps existing route behavior: validation errors and 404s are unchanged", async () => {
    expect((await appDefault.request("/definitely-not-a-route")).status).toBe(404);
    const bad = await appDefault.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "jobId is required", status: 400 });
    const ship = await appDefault.request("/api/ship", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(ship.status).toBe(400);
  });

  it("registers every API route the web proxies call", async () => {
    // A route that exists answers with its own validation error, never the
    // router's generic 404.
    const paths = [
      "analyze", "apply", "checkout", "forge", "forge-structured", "forge-verify",
      "install", "investigate", "regression", "reproduce", "run-tests", "ship", "verify",
    ];
    for (const p of paths) {
      const res = await appDefault.request(`/api/${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status, p).not.toBe(404);
    }
    expect((await appDefault.request("/api/jobs")).status).not.toBe(404);
  });
});

describe("vercel.json (API project)", () => {
  const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;

  it("installs at the workspace root with the lockfile and builds @hubris/api's dependencies in order", () => {
    expect(config.installCommand).toBe("pnpm install --frozen-lockfile");
    // `...` = the package AND everything it depends on; web is not built.
    expect(config.buildCommand).toBe("pnpm turbo run build --filter=@hubris/api...");
    expect(String(config.buildCommand)).not.toContain("web");
  });

  it("does not guess an output directory or a function glob it cannot verify", () => {
    expect(config).not.toHaveProperty("outputDirectory");
    expect(config).not.toHaveProperty("functions");
    expect(config).not.toHaveProperty("builds");
  });

  it("every workspace dependency of the API is built by that filter", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const workspaceDeps = Object.entries(pkg.dependencies)
      .filter(([, v]) => v.startsWith("workspace:"))
      .map(([k]) => k)
      .sort();
    expect(workspaceDeps).toEqual(["@hubris/analyzer", "@hubris/db", "@hubris/llm", "@hubris/sandbox"]);
  });
});

describe("runtime environment variables are read at call time, server-side", () => {
  it("NEBIUS_* configure the model and the sandbox when they are set after import", () => {
    vi.stubEnv("NEBIUS_API_KEY", "");
    vi.stubEnv("NEBIUS_MODEL", "");
    vi.stubEnv("NEBIUS_PROJECT_ID", "");
    expect(llmConfigFromEnv()).toBeNull();
    expect(sandboxConfigFromEnv()).toBeNull();
    vi.stubEnv("NEBIUS_API_KEY", "k");
    vi.stubEnv("NEBIUS_MODEL", "m");
    vi.stubEnv("NEBIUS_PROJECT_ID", "p");
    expect(llmConfigFromEnv()).toMatchObject({ apiKey: "k", model: "m" });
    expect(sandboxConfigFromEnv()).toMatchObject({ apiKey: "k", projectId: "p" });
  });

  it("GITHUB_TOKEN is read per request and blank means absent", () => {
    vi.stubEnv("GITHUB_TOKEN", "  ");
    expect(githubTokenFromEnv()).toBeNull();
    vi.stubEnv("GITHUB_TOKEN", "ghp_x");
    expect(githubTokenFromEnv()).toBe("ghp_x");
  });

  it("DATABASE_URL is read lazily: no database without it, a client with it", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await closeDb();
    expect(getDb()).toBeNull();
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/x");
    expect(getDb()).not.toBeNull(); // lazy client; nothing connects until a query
    await closeDb();
  });

  it("no secret is ever readable through a NEXT_PUBLIC variable (API source)", () => {
    for (const file of readdirSync(`${API_DIR}src`).filter((f) => f.endsWith(".ts"))) {
      expect(read(`src/${file}`), file).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET|DATABASE|NEBIUS)/);
    }
  });
});
