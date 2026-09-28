import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { app } from "../src/app";
import {
  assessVerification,
  buildApplyCheckScript,
  buildForgeVerifyScript,
  buildTargetVerificationCommand,
  CHECK_DONE_MARKER,
  detectTestRunner,
  getForgeContext,
  parseApplyCheckResult,
  parseFailingTests,
  parseTargetVerification,
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

// ---- Exact target-scenario verification ----
//
// "Target test passed" is repair evidence; "full suite passed" is regression
// evidence. The assessment never infers the first from the second.

const UNRELATED_OUTPUT = [
  " FAIL  tests/cart.test.ts > carts > clears a cart",
  " FAIL  tests/sessions.test.ts > sessions > expires sessions",
  " FAIL  tests/users.test.ts > users > resets a password",
  " Test Files  3 failed | 2 passed (5)",
].join("\n");

const SCENARIO = "applies a discount code to the order total";
const TARGET_FILE = "tests/orders.test.ts";
const TARGET_CMD = `pnpm exec vitest run '${TARGET_FILE}' -t '${SCENARIO}'`;

function target(over: Partial<{
  ran: boolean;
  exitCode: number | null;
  timedOut: boolean;
  testFile: string;
  scenario: string;
  command: string;
}> = {}) {
  return {
    testFile: TARGET_FILE,
    scenario: SCENARIO,
    command: TARGET_CMD,
    ran: true,
    exitCode: 0,
    timedOut: false,
    ...over,
  };
}

describe("parseFailingTests", () => {
  it("extracts failing test files from vitest/jest/pytest output", () => {
    expect(parseFailingTests(UNRELATED_OUTPUT)).toEqual([
      "tests/cart.test.ts",
      "tests/sessions.test.ts",
      "tests/users.test.ts",
    ]);
    expect(parseFailingTests("FAILED tests/test_x.py::test_y - assert 1 == 2")).toEqual([
      "tests/test_x.py",
    ]);
    expect(parseFailingTests("all good")).toEqual([]);
    expect(parseFailingTests("")).toEqual([]);
  });
});

describe("parseTargetVerification", () => {
  it("reads the targeted-run completion marker", () => {
    expect(parseTargetVerification("noise\nTARGET_VERIFY_DONE 0\nmore")).toEqual({
      ran: true,
      exitCode: 0,
    });
    expect(parseTargetVerification("TARGET_VERIFY_DONE 1")).toEqual({ ran: true, exitCode: 1 });
    expect(parseTargetVerification("no marker")).toEqual({ ran: false, exitCode: null });
  });
});

describe("detectTestRunner / buildTargetVerificationCommand", () => {
  it("detects the runner from the repo test script", () => {
    expect(detectTestRunner("vitest run")).toBe("vitest");
    expect(detectTestRunner("jest --coverage")).toBe("jest");
    expect(detectTestRunner("node --test")).toBeNull();
  });

  it("builds a shell-quoted targeted command using the detected manager/runner", () => {
    const cmd = buildTargetVerificationCommand({
      manager: "pnpm",
      testScript: "vitest run",
      testFile: TARGET_FILE,
      scenario: SCENARIO,
    });
    expect(cmd).toBe(`pnpm exec vitest run 'tests/orders.test.ts' -t '${SCENARIO}'`);
    const npm = buildTargetVerificationCommand({
      manager: "npm",
      testScript: "vitest",
      testFile: TARGET_FILE,
      scenario: SCENARIO,
    });
    expect(npm).toBe(`npx vitest run 'tests/orders.test.ts' -t '${SCENARIO}'`);
  });

  it("returns null for an unsupported runner or missing context", () => {
    expect(buildTargetVerificationCommand({ manager: "pnpm", testScript: "node --test", testFile: TARGET_FILE, scenario: SCENARIO })).toBeNull();
    expect(buildTargetVerificationCommand({ manager: "pnpm", testScript: "vitest", testFile: null, scenario: SCENARIO })).toBeNull();
    expect(buildTargetVerificationCommand({ manager: "pnpm", testScript: "vitest", testFile: TARGET_FILE, scenario: null })).toBeNull();
  });

  it("treats a scenario with shell metacharacters as data", () => {
    const cmd = buildTargetVerificationCommand({
      manager: "pnpm",
      testScript: "vitest",
      testFile: "tests/x.test.ts",
      scenario: "a 'b' $(rm) c",
    });
    // Single-quoted with quotes escaped; never concatenated raw.
    expect(cmd).toBe(`pnpm exec vitest run 'tests/x.test.ts' -t 'a '\\''b'\\'' $(rm) c'`);
  });
});

describe("assessVerification (exact target-scenario evidence)", () => {
  it("exact target passes + unrelated full-suite failures => REPAIR_VERIFIED", () => {
    const a = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: target(),
    });
    expect(a.state).toBe("REPAIR_VERIFIED");
    expect(a.targetVerificationPassed).toBe(true);
    expect(a.targetScenario).toBe(SCENARIO);
    expect(a.targetTestFile).toBe(TARGET_FILE);
    expect(a.unrelatedTestFailures).toBe(3);
    expect(a.failedTests).not.toContain(TARGET_FILE);
  });

  it("exact target fails => REPAIR_NOT_VERIFIED (takes precedence over the suite)", () => {
    const a = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: target({ exitCode: 1 }),
    });
    expect(a.state).toBe("REPAIR_NOT_VERIFIED");
    expect(a.targetVerificationPassed).toBe(false);
  });

  it("exact target passes + full suite passes => FULL_SUITE_PASSED", () => {
    const a = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 0,
      timedOut: false,
      stdout: " Test Files  5 passed (5)",
      target: target(),
    });
    expect(a.state).toBe("FULL_SUITE_PASSED");
    expect(a.fullSuitePassed).toBe(true);
    expect(a.targetVerificationPassed).toBe(true);
  });

  it("missing reproduction scenario => VERIFICATION_INCOMPLETE (no target inferred)", () => {
    const a = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: null,
    });
    expect(a.state).toBe("VERIFICATION_INCOMPLETE");
    expect(a.targetVerificationPassed).toBeNull();
  });

  it("targeted command timeout => VERIFICATION_INCOMPLETE (fail closed)", () => {
    const a = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: "",
      target: target({ timedOut: true, exitCode: null }),
    });
    expect(a.state).toBe("VERIFICATION_INCOMPLETE");
    expect(a.targetVerificationPassed).toBeNull();
  });

  it("target could not be executed (marker absent / 127) => VERIFICATION_INCOMPLETE", () => {
    const notRun = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: target({ ran: false, exitCode: null }),
    });
    expect(notRun.state).toBe("VERIFICATION_INCOMPLETE");
    const notFound = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: target({ exitCode: 127 }),
    });
    expect(notFound.state).toBe("VERIFICATION_INCOMPLETE");
  });

  it("never-applied patch is INCOMPLETE, never a false repair verdict", () => {
    const a = assessVerification({
      patchApplied: false,
      verificationStarted: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      target: target(),
    });
    expect(a.state).toBe("VERIFICATION_INCOMPLETE");
    expect(a.patchApplied).toBe(false);
  });

  it("legacy runs without a target preserve legacy behavior", () => {
    const pass = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 0,
      timedOut: false,
      stdout: " Test Files  5 passed (5)",
      target: null,
    });
    expect(pass.state).toBe("FULL_SUITE_PASSED");
    const fail = assessVerification({
      patchApplied: true,
      verificationStarted: true,
      exitCode: 1,
      timedOut: false,
      stdout: UNRELATED_OUTPUT,
      target: null,
    });
    expect(fail.state).toBe("VERIFICATION_INCOMPLETE");
  });
});
