import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildApplyScript,
  isPlausibleDiff,
  PATCH_OK_MARKER,
} from "../src/apply";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const DIFF = `diff --git a/src/users.ts b/src/users.ts
--- a/src/users.ts
+++ b/src/users.ts
@@ -1,3 +1,4 @@
+// hubris live comment
 export interface User {
   id: string;
 `;

describe("POST /api/apply validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId and diff", async () => {
    const res = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-diff payload", async () => {
    const res = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        diff: "just some text",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        diff: DIFF,
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe("isPlausibleDiff", () => {
  it("accepts unified diffs", () => {
    expect(isPlausibleDiff(DIFF)).toBe(true);
    expect(isPlausibleDiff("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n")).toBe(true);
  });

  it.each(["", "short", "no hunks here --- +++", "x".repeat(20001)])(
    "rejects %s",
    (d) => {
      expect(isPlausibleDiff(d)).toBe(false);
    }
  );
});

describe("buildApplyScript", () => {
  it("installs git, applies the staged diff, then installs and tests", () => {
    const cmd = buildApplyScript("pnpm", []);
    expect(cmd).toContain("apt-get install -y -qq git");
    expect(cmd).toContain("git apply '/tmp/hubris-upload/patch.diff'");
    expect(cmd).toContain(`echo ${PATCH_OK_MARKER}`);
    // Order: apply < patch-marker < install < test-marker < suite.
    expect(cmd.indexOf("git apply")).toBeLessThan(cmd.indexOf(PATCH_OK_MARKER));
    expect(cmd.indexOf(PATCH_OK_MARKER)).toBeLessThan(cmd.indexOf("pnpm install"));
    expect(cmd.indexOf("pnpm install")).toBeLessThan(cmd.indexOf("TEST_BEGIN"));
    expect(cmd.indexOf("TEST_BEGIN")).toBeLessThan(cmd.indexOf("pnpm test"));
  });
});
