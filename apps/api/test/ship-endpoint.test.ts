import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";

const PATCH = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
const PATCH_SHA = createHash("sha256").update(PATCH).digest("hex");
const PATCH_BYTES = Buffer.byteLength(PATCH, "utf-8");
const COMMIT = "a".repeat(40);

function eligibleEntry(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "VERIFIED",
    investigationId: "inv-1",
    apply: { applied: true },
    verification: {
      command: "pnpm test",
      exitCode: 1,
      timedOut: false,
      passed: false,
      assessment: {
        state: "REPAIR_VERIFIED",
        patchApplied: true,
        targetVerificationPassed: true,
        fullSuitePassed: false,
        unrelatedTestFailures: 3,
        failedTests: ["tests/cart.test.ts"],
      },
    },
    targetVerification: { testFile: "tests/orders.test.ts", scenario: "applies a discount", passed: true },
    canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES, content: PATCH },
    source: {
      repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
      analysisCommitSha: COMMIT,
      executionCommitSha: COMMIT,
      commitSha: COMMIT,
    },
    ...over,
  };
}

const READY_INVESTIGATION = {
  investigationId: "inv-1",
  jobId: "job-1",
  status: "READY",
  focus: "the discount is not applied",
  plan: {
    target: { file: "src/orders.ts", function: "createOrder" },
    currentBehavior: "SAVE10 charges the full subtotal.",
    expectedBehavior: "expect(order.total).toBe(1350)",
  },
};

let RESULT: Record<string, unknown> = {};

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  const job = {
    id: "00000000-0000-0000-0000-000000000000",
    repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
    status: "complete",
    result: { forgeRuns: [], investigationRuns: [] },
    error: null,
  };
  return {
    ...actual,
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [{ ...job, result: RESULT }] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function ship(body: object) {
  const { app } = await import("../src/app");
  return app.request("/api/ship", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", ...body }),
  });
}

describe("POST /api/ship fail-closed gates", () => {
  it("returns 400 without a forgeRunId", async () => {
    RESULT = { forgeRuns: [eligibleEntry()], investigationRuns: [READY_INVESTIGATION] };
    expect((await ship({})).status).toBe(400);
  });

  it("returns 404 for an unknown Forge run", async () => {
    RESULT = { forgeRuns: [eligibleEntry()], investigationRuns: [READY_INVESTIGATION] };
    expect((await ship({ forgeRunId: "missing" })).status).toBe(404);
  });

  it("rejects a legacy run without an assessment", async () => {
    RESULT = {
      forgeRuns: [eligibleEntry({ verification: { command: "pnpm test", exitCode: 0, passed: true } })],
      investigationRuns: [READY_INVESTIGATION],
    };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Cannot create PR");
  });

  it("rejects a REPAIR_NOT_VERIFIED run", async () => {
    RESULT = {
      forgeRuns: [
        eligibleEntry({
          verification: { assessment: { state: "REPAIR_NOT_VERIFIED", targetVerificationPassed: false, fullSuitePassed: false } },
        }),
      ],
      investigationRuns: [READY_INVESTIGATION],
    };
    expect((await ship({ forgeRunId: "run-1" })).status).toBe(409);
  });

  it("rejects when the bound investigation is missing", async () => {
    RESULT = { forgeRuns: [eligibleEntry()], investigationRuns: [] };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("provenance could not be established");
  });

  it("requires GitHub authorization (503, action required) and never pushes partially", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    RESULT = { forgeRuns: [eligibleEntry()], investigationRuns: [READY_INVESTIGATION] };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string; state?: string };
    expect(data.error).toContain("GitHub authorization is required");
    expect(data.state).toBe("ACTION_REQUIRED");
  });

  it("rejects a patch whose content does not match its SHA", async () => {
    RESULT = {
      forgeRuns: [eligibleEntry({ canonicalPatch: { sha: "0".repeat(64), bytes: PATCH_BYTES, content: PATCH } })],
      investigationRuns: [READY_INVESTIGATION],
    };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("does not match");
  });

  it("returns an existing PR instead of creating a duplicate", async () => {
    RESULT = {
      forgeRuns: [
        eligibleEntry({
          pullRequest: {
            provider: "github",
            repository: "kaiser1x/test2-codebase",
            branch: "hubris/fix/x",
            baseBranch: "main",
            commitSha: COMMIT,
            prNumber: 7,
            prUrl: "https://github.com/kaiser1x/test2-codebase/pull/7",
            investigationId: "inv-1",
            forgeRunId: "run-1",
            canonicalPatchSha: PATCH_SHA,
            createdAt: "2026-01-01T00:00:00.000Z",
            status: "OPEN",
          },
        }),
      ],
      investigationRuns: [READY_INVESTIGATION],
    };
    vi.stubEnv("GITHUB_TOKEN", "secret-token");
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { duplicate?: boolean; pullRequest?: { prNumber: number } };
    expect(data.duplicate).toBe(true);
    expect(data.pullRequest?.prNumber).toBe(7);
  });
});

describe("POST /api/ship exact-run binding and patch gates", () => {
  it("looks up the exact Forge run by id, not the latest", async () => {
    RESULT = {
      forgeRuns: [
        eligibleEntry({ id: "run-1", canonicalPatch: { sha: "0".repeat(64), bytes: 1, content: "x" } }),
        eligibleEntry({ id: "run-2" }),
      ],
      investigationRuns: [READY_INVESTIGATION],
    };
    vi.stubEnv("GITHUB_TOKEN", "");
    // run-2 is the exact, eligible one; the endpoint must use it (reach the
    // authorization step) rather than the ineligible run-1.
    const res = await ship({ forgeRunId: "run-2" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub authorization is required");
  });

  it("rejects a forgeRunId that does not belong to the requested job", async () => {
    RESULT = { forgeRuns: [eligibleEntry({ id: "run-1" })], investigationRuns: [READY_INVESTIGATION] };
    const res = await ship({ forgeRunId: "run-on-another-job" });
    expect(res.status).toBe(404);
  });

  it("rejects when the canonical patch content was not persisted", async () => {
    RESULT = {
      forgeRuns: [eligibleEntry({ canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES } })],
      investigationRuns: [READY_INVESTIGATION],
    };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("not persisted");
  });
});

describe("POST /api/ship canonical patch persistence gates", () => {
  it("accepts a valid persisted canonical patch (passes patch verification)", async () => {
    RESULT = { forgeRuns: [eligibleEntry()], investigationRuns: [READY_INVESTIGATION] };
    vi.stubEnv("GITHUB_TOKEN", "");
    const res = await ship({ forgeRunId: "run-1" });
    // Patch integrity + provenance passed; only GitHub authorization is missing.
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub authorization is required");
  });

  it("rejects a patch whose byte count is inconsistent with its content", async () => {
    RESULT = {
      forgeRuns: [eligibleEntry({ canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES + 5, content: PATCH } })],
      investigationRuns: [READY_INVESTIGATION],
    };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("byte count");
  });

  it("rejects a legacy sha/bytes-only run (backward compatible, fail closed)", async () => {
    RESULT = {
      forgeRuns: [eligibleEntry({ canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES } })],
      investigationRuns: [READY_INVESTIGATION],
    };
    const res = await ship({ forgeRunId: "run-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("content was not persisted");
  });
});
