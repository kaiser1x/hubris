import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildTestScript,
  DEFAULT_TEST_TIMING,
  parseTestCommand,
  TEST_BEGIN_MARKER,
  testTimingFromEnv,
} from "../src/testrun";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/run-tests validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/run-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/run-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an overlong testCommand", async () => {
    const res = await app.request("/api/run-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        testCommand: "x".repeat(501),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/run-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("parseTestCommand", () => {
  it("reads scripts.test", () => {
    expect(parseTestCommand(JSON.stringify({ scripts: { test: "vitest run" } }))).toBe(
      "vitest run"
    );
  });

  it("returns null when absent, blank, or unparseable", () => {
    expect(parseTestCommand(JSON.stringify({ scripts: {} }))).toBeNull();
    expect(parseTestCommand(JSON.stringify({ scripts: { test: "  " } }))).toBeNull();
    expect(parseTestCommand(JSON.stringify({ scripts: { test: 42 } }))).toBeNull();
    expect(parseTestCommand("{nope")).toBeNull();
    expect(parseTestCommand("[]")).toBeNull();
  });
});

describe("testTimingFromEnv", () => {
  it("returns test-sized defaults", () => {
    expect(testTimingFromEnv({})).toEqual(DEFAULT_TEST_TIMING);
    expect(testTimingFromEnv({ HUBRIS_TEST_TIMEOUT: "0" })).toEqual(DEFAULT_TEST_TIMING);
  });

  it("honors overrides", () => {
    expect(
      testTimingFromEnv({ HUBRIS_TEST_TIMEOUT: "120", HUBRIS_TEST_WAIT_MS: "180000" })
    ).toEqual({ timeoutS: 120, waitMs: 180000 });
  });
});

describe("buildTestScript", () => {
  it("installs with scripts disabled, marks the test phase, then invokes", () => {
    const cmd = buildTestScript("pnpm", []);
    expect(cmd).toContain("--ignore-scripts");
    expect(cmd).toContain(`echo ${TEST_BEGIN_MARKER}`);
    expect(cmd).toContain("pnpm test");
    expect(cmd.indexOf(TEST_BEGIN_MARKER)).toBeLessThan(cmd.indexOf("pnpm test"));
  });

  it("honors an explicit invocation and drops secret names", () => {
    const cmd = buildTestScript("npm", [".env"], "npm run test:unit");
    expect(cmd).toContain("npm run test:unit");
    expect(cmd).toContain("rm -f '.env'");
  });
});
