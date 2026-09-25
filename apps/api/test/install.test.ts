import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildInstallScript,
  DEFAULT_INSTALL_TIMING,
  detectManager,
  installTimingFromEnv,
} from "../src/install";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/install validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown manager", async () => {
    const res = await app.request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        manager: "yarn",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        ref: "$(whoami)",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("detectManager", () => {
  it("detects pnpm and npm from root lockfiles", () => {
    expect(detectManager(["package.json", "pnpm-lock.yaml", "src/a.ts"])).toBe("pnpm");
    expect(detectManager(["package.json", "package-lock.json"])).toBe("npm");
  });

  it("prefers pnpm on ties and ignores nested lockfiles", () => {
    expect(detectManager(["pnpm-lock.yaml", "package-lock.json"])).toBe("pnpm");
    expect(detectManager(["package.json", "fixtures/x/pnpm-lock.yaml"])).toBeNull();
    expect(detectManager(["package.json"])).toBeNull();
  });
});

describe("installTimingFromEnv", () => {
  it("returns install-sized defaults", () => {
    expect(installTimingFromEnv({})).toEqual(DEFAULT_INSTALL_TIMING);
    expect(installTimingFromEnv({ HUBRIS_INSTALL_TIMEOUT: "0" })).toEqual(
      DEFAULT_INSTALL_TIMING
    );
  });

  it("honors overrides", () => {
    expect(
      installTimingFromEnv({ HUBRIS_INSTALL_TIMEOUT: "600", HUBRIS_INSTALL_WAIT_MS: "660000" })
    ).toEqual({ timeoutS: 600, waitMs: 660000 });
  });
});

describe("buildInstallScript", () => {
  it("extracts then installs with lifecycle scripts disabled", () => {
    const cmd = buildInstallScript("pnpm", []);
    expect(cmd).toContain("tar -xf '/tmp/hubris-upload/repo.tar'");
    expect(cmd).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(cmd).toContain("INSTALL_DONE");
  });

  it("uses npm ci for npm repos", () => {
    const cmd = buildInstallScript("npm", [".env"]);
    expect(cmd).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(cmd).toContain("rm -f '.env'");
  });

  it("never enables lifecycle scripts", () => {
    for (const m of ["pnpm", "npm"] as const) {
      const cmd = buildInstallScript(m, []);
      expect(cmd).not.toMatch(/--ignore-scripts=false/);
      expect(cmd).toContain("--ignore-scripts");
    }
  });
});
