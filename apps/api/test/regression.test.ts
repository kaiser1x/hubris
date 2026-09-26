import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildRegressionScript,
  DEFAULT_REGRESSION_TEST_PATH,
  isSafeTestPath,
  REGRESSION_STAGING_PATH,
} from "../src/regression";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/regression validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither testContent nor generate is given", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when both testContent and generate are given", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        testContent: "x",
        generate: true,
        focus: "y",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when generating without focus", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        generate: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsafe testPath", async () => {
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        testContent: "x",
        testPath: "../../evil.test.ts",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        testContent: "x",
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe("isSafeTestPath", () => {
  it("accepts the default and nested test paths", () => {
    expect(isSafeTestPath(DEFAULT_REGRESSION_TEST_PATH)).toBe(true);
    expect(isSafeTestPath("tests/payments-regression.test.ts")).toBe(true);
    expect(isSafeTestPath("a.test.js")).toBe(true);
  });

  it.each([
    "",
    "/abs.test.ts",
    "../escape.test.ts",
    "a/../../b.test.ts",
    "dir/",
    "not-a-test.ts",
    "x.test.ts ",
    "semi;colon.test.ts",
    "back\\slash.test.ts",
    ".hidden.test.ts",
    "a".repeat(201),
  ])("rejects %s", (p) => {
    expect(isSafeTestPath(p)).toBe(false);
  });
});

describe("buildRegressionScript", () => {
  it("copies the staged file into the workspace before installing", () => {
    const cmd = buildRegressionScript("pnpm", [], "tests/regression.test.ts");
    const stagingIdx = cmd.indexOf(`cp '${REGRESSION_STAGING_PATH}'`);
    expect(stagingIdx).toBeGreaterThan(-1);
    expect(cmd).toContain("'/tmp/hubris-repo/tests/regression.test.ts'");
    expect(cmd).toContain("mkdir -p '/tmp/hubris-repo/tests'");
    // Order: copy < install < marker < suite.
    expect(stagingIdx).toBeLessThan(cmd.indexOf("pnpm install"));
    expect(cmd.indexOf("pnpm install")).toBeLessThan(cmd.indexOf("TEST_BEGIN"));
    expect(cmd.indexOf("TEST_BEGIN")).toBeLessThan(cmd.indexOf("pnpm test"));
  });
});
