import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { app } from "../src/app";
import {
  buildApplyCheckScript,
  buildForgeVerifyScript,
  CHECK_DONE_MARKER,
  getForgeContext,
  parseApplyCheckResult,
  resolveForgeStatus,
  toAttemptRecord,
  VERIFY_BEGIN_MARKER,
} from "../src/forgeverify";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/forge-verify validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/forge-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/forge-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-diff caller patch", async () => {
    const res = await app.request("/api/forge-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        diff: "not a patch",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/forge-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe("getForgeContext", () => {
  const twin = {
    repository: { name: "kaiser1x/ts-js-dummy" },
    stats: { functions: 2, classes: 0, endpoints: 1, tests: 1, relationships: 3 },
    full: {
      functions: [{ name: "alpha", path: "src/deep/a.ts", line: 7 }],
      endpoints: [{ method: "GET", path: "/start" }],
      relationships: [{ from: "src/deep/a.ts", to: "beta", type: "CALLS" }],
    },
  };

  it("maps the twin like the forge handler (short paths, defaults)", () => {
    const ctx = getForgeContext({ repoUrl: "https://github.com/x/y.git", status: "complete", result: twin });
    expect(ctx).not.toBeNull();
    expect(ctx!.repoName).toBe("kaiser1x/ts-js-dummy");
    expect(ctx!.functions).toEqual([{ name: "alpha", file: "src/deep/a.ts", line: 7 }]);
    expect(ctx!.endpoints).toEqual(["GET /start"]);
    expect(ctx!.relationships).toEqual(["src/deep/a.ts CALLS beta"]);
  });

  it("returns null without a completed analysis", () => {
    expect(getForgeContext({ repoUrl: "u", status: "pending", result: twin })).toBeNull();
    expect(getForgeContext({ repoUrl: "u", status: "complete", result: null })).toBeNull();
  });
});

describe("resolveForgeStatus", () => {
  it("walks the happy path", () => {
    expect(
      resolveForgeStatus({ patchOk: true, verifyBegin: true, exitCode: 0, timedOut: false })
    ).toBe("VERIFIED");
  });

  it.each([
    [{ patchOk: false, verifyBegin: false, exitCode: 1, timedOut: false }, "APPLY_FAILED"],
    [{ patchOk: true, verifyBegin: false, exitCode: 1, timedOut: false }, "FAILED"],
    [{ patchOk: true, verifyBegin: true, exitCode: 1, timedOut: false }, "FAILED"],
    [{ patchOk: true, verifyBegin: true, exitCode: 0, timedOut: true }, "TIMEOUT"],
    [{ patchOk: true, verifyBegin: true, exitCode: null, timedOut: false }, "FAILED"],
  ])("maps %s to %s", (signals, status) => {
    expect(resolveForgeStatus(signals as never)).toBe(status);
  });

  it("never verifies without an actual exit 0", () => {
    for (const exitCode of [1, 2, 127, null]) {
      const s = resolveForgeStatus({ patchOk: true, verifyBegin: true, exitCode, timedOut: false });
      expect(s).not.toBe("VERIFIED");
    }
  });
});

describe("buildForgeVerifyScript", () => {
  it("stages, applies, installs, then runs the verification command", () => {
    const cmd = buildForgeVerifyScript("pnpm", [], "pnpm test --runInBand");
    expect(cmd).toContain("git apply '/tmp/hubris-upload/patch.diff'");
    expect(cmd).toContain("pnpm test --runInBand");
    expect(cmd).toContain(`echo ${VERIFY_BEGIN_MARKER}`);
    const order = ["git apply", "PATCH_OK", "pnpm install", VERIFY_BEGIN_MARKER, "pnpm test --runInBand"];
    const idx = order.map((s) => cmd.indexOf(s));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe("buildApplyCheckScript", () => {
  it("extracts and checks without installing or testing", () => {
    const cmd = buildApplyCheckScript([".env"]);
    expect(cmd).toContain("tar -xf '/tmp/hubris-upload/repo.tar'");
    expect(cmd).toContain("rm -f '.env'");
    expect(cmd).toContain("git apply --check '/tmp/hubris-upload/patch.diff'");
    expect(cmd).toContain(`echo ${CHECK_DONE_MARKER}`);
    expect(cmd).not.toContain("pnpm install");
    expect(cmd).not.toContain("TEST_BEGIN");
  });
});

describe("parseApplyCheckResult", () => {
  it("passes only on exit 0 with the marker and no timeout", () => {
    const good = parseApplyCheckResult({
      exitCode: 0, stdout: `ok\n${CHECK_DONE_MARKER}\n`, stderr: "", timedOut: false,
    });
    expect(good).toEqual({ passed: true, timedOut: false, error: expect.any(String) });
    // Marker missing despite exit 0 is NOT a pass (script may have died early).
    expect(
      parseApplyCheckResult({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }).passed
    ).toBe(false);
    expect(
      parseApplyCheckResult({ exitCode: 1, stdout: "x", stderr: "corrupt", timedOut: false }).passed
    ).toBe(false);
    const timed = parseApplyCheckResult({
      exitCode: null, stdout: "", stderr: "", timedOut: true,
    });
    expect(timed.passed).toBe(false);
    expect(timed.timedOut).toBe(true);
  });

  it("bounds the error text for the redraft prompt", () => {
    const big = "e".repeat(5000);
    const out = parseApplyCheckResult({ exitCode: 1, stdout: big, stderr: big, timedOut: false });
    expect(out.error.length).toBeLessThanOrEqual(2000);
  });
});

describe("toAttemptRecord", () => {
  it("records hashes and verdicts, never patch text", async () => {
    const { toAttemptRecord } = await import("../src/forgeverify");
    const { createHash } = await import("node:crypto");
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const rec = toAttemptRecord({ attempt: 1, source: "forge", diff, parseAccepted: true, applyCheckPassed: false });
    expect(rec).toEqual({
      attempt: 1,
      source: "forge",
      patchSha256: createHash("sha256").update(diff).digest("hex"),
      patchBytes: Buffer.byteLength(diff, "utf-8"),
      parseAccepted: true,
      applyCheckPassed: false,
    });
    expect(JSON.stringify(rec)).not.toContain("diff --git");
    const empty = toAttemptRecord({ attempt: 2, source: "forge-redraft", diff: null, parseAccepted: false, applyCheckPassed: null });
    expect(empty.patchSha256).toBeNull();
    expect(empty.patchBytes).toBeNull();
  });
});
