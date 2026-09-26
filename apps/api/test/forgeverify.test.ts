import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildForgeVerifyScript,
  getForgeContext,
  resolveForgeStatus,
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
