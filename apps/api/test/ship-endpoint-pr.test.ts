import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { ShipDeps } from "../src/ship";

// End-to-end through POST /api/ship: the REAL route, the REAL shipForgeRun
// orchestration (patch reproduction check, branch safety, push gating), but a
// fake git executor and a fake GitHub API. No network, no real git, no writes.

const PATCH = "diff --git a/src/orders.ts b/src/orders.ts\n--- a/src/orders.ts\n+++ b/src/orders.ts\n@@ -1 +1 @@\n-  total = subtotal\n+  total = applyDiscount(subtotal, discountCode)\n";
const PATCH_SHA = createHash("sha256").update(PATCH).digest("hex");
const PATCH_BYTES = Buffer.byteLength(PATCH, "utf-8");
const ANALYZED = "a1".repeat(20);
const EXECUTION = ANALYZED; // SHIP requires analyzed === execution
const LOCAL_HEAD = "c3".repeat(20);
const JOB_ID = "00000000-0000-0000-0000-000000000000";
const INVESTIGATION_ID = "inv-endpoint-7f3a";
const FORGE_RUN_ID = "forge-run-endpoint-42";
const THREE_FAILURES = ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"];

function forgeRun(over: Record<string, unknown> = {}, assessment: Record<string, unknown> = {}) {
  return {
    id: FORGE_RUN_ID,
    status: "VERIFIED",
    investigationId: INVESTIGATION_ID,
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
        targetScenario: "applies a discount code to the order total",
        targetTestFile: "tests/orders.test.ts",
        fullSuitePassed: false,
        unrelatedTestFailures: 3,
        failedTests: THREE_FAILURES,
        ...assessment,
      },
    },
    // Raw persisted record: no `passed` field (matches real Forge output).
    targetVerification: {
      scenario: "applies a discount code to the order total",
      testFile: "tests/orders.test.ts",
      ran: true,
      exitCode: 0,
      timedOut: false,
    },
    canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES, content: PATCH },
    source: {
      repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
      analysisCommitSha: ANALYZED,
      executionCommitSha: EXECUTION,
      commitSha: EXECUTION,
    },
    ...over,
  };
}

const INVESTIGATION = {
  investigationId: INVESTIGATION_ID,
  jobId: JOB_ID,
  status: "READY",
  focus: "the discount code is not applied to the order total",
  plan: {
    target: { file: "src/orders.ts", function: "createOrder" },
    currentBehavior: "SAVE10 charges the full subtotal.",
    expectedBehavior: "expect(order.total).toBe(1350)",
  },
};

let RESULT: Record<string, unknown> = {};

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  return {
    ...actual,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: async () => [
            { id: "00000000-0000-0000-0000-000000000000", repoUrl: "https://github.com/kaiser1x/test2-codebase.git", status: "complete", result: RESULT, error: null },
          ],
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    }),
  };
});

// Inject fake git/fetch into the real orchestration. Production code and its
// call site in app.ts are unchanged; only the default dependencies are swapped.
const gitCalls: string[][] = [];
// What the fake remote reports for `git ls-remote origin refs/heads/<name>`.
let remoteHeads: Record<string, string> = {};
// Simulates a runtime with no git executable at all.
let gitMissing = false;
vi.mock("../src/ship", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ship")>();
  const fakeDeps: ShipDeps = {
    exec: async (args) => {
      gitCalls.push(args);
      if (gitMissing) throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      const [cmd] = args;
      if (cmd === "ls-remote") {
        const ref = args[args.length - 1];
        const name = ref.replace(/^refs\/heads\//, "");
        const sha = ref.startsWith("refs/heads/hubris/fix/") ? undefined : remoteHeads[name];
        return { stdout: sha ? `${sha}\t${ref}\n` : "", stderr: "" };
      }
      if (cmd === "rev-parse") return { stdout: `${LOCAL_HEAD}\n`, stderr: "" };
      if (cmd === "diff" && args.length === 2 && args[1] === "--cached") return { stdout: PATCH, stderr: "" };
      return { stdout: "", stderr: ""  }; // init/remote/fetch/checkout/apply/commit/push/ls-remote/diff --check/--name-only
    },
    fetchImpl: ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch,
    tmpDir: async () => "/virtual/hubris-ship-test",
    removeDir: async () => undefined,
    writeFile: async () => undefined,
  };
  return {
    ...actual,
    shipForgeRun: (input: Parameters<typeof actual.shipForgeRun>[0]) => actual.shipForgeRun(input, fakeDeps),
  };
});

interface GithubCall {
  method: string;
  path: string;
  body: unknown;
}
let githubCalls: GithubCall[] = [];

function installFakeGitHub() {
  githubCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const method = init?.method ?? "GET";
      githubCalls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.hostname !== "api.github.com") throw new Error(`unexpected network call to ${u.hostname}`);
      if (method === "GET" && u.pathname === "/repos/kaiser1x/test2-codebase") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (method === "GET" && u.pathname === "/repos/kaiser1x/test2-codebase/pulls") {
        return new Response("[]", { status: 200 });
      }
      if (method === "POST" && u.pathname === "/repos/kaiser1x/test2-codebase/pulls") {
        return new Response(JSON.stringify({ number: 99, html_url: "https://github.com/kaiser1x/test2-codebase/pull/99" }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    })
  );
}

beforeEach(() => {
  gitCalls.length = 0;
  gitMissing = false;
  remoteHeads = { main: ANALYZED };
  vi.stubEnv("GITHUB_TOKEN", "test-token-not-real");
  installFakeGitHub();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function ship(forgeRunId: string = FORGE_RUN_ID) {
  const { app } = await import("../src/app");
  return app.request("/api/ship", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: JOB_ID, forgeRunId }),
  });
}

function prCreation(): { title: string; body: string; head: string; base: string } {
  const posts = githubCalls.filter((c) => c.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe("/repos/kaiser1x/test2-codebase/pulls");
  return posts[0].body as { title: string; body: string; head: string; base: string };
}

describe("POST /api/ship → GitHub PR-creation request", () => {
  it("sends the final verified Forge result in the PR body", async () => {
    // A decoy run for the same job must never leak into the body.
    const decoy = forgeRun(
      { id: "forge-run-decoy" },
      { state: "REPAIR_VERIFIED", unrelatedTestFailures: 9, failedTests: ["tests/decoy.test.ts"] }
    );
    RESULT = { forgeRuns: [decoy, forgeRun()], investigationRuns: [INVESTIGATION] };

    const res = await ship();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { state: string; pullRequest: { prNumber: number; forgeRunId: string; investigationId: string } };
    expect(data.state).toBe("PR_CREATED");
    expect(data.pullRequest.prNumber).toBe(99);
    expect(data.pullRequest.forgeRunId).toBe(FORGE_RUN_ID);
    expect(data.pullRequest.investigationId).toBe(INVESTIGATION_ID);

    const pr = prCreation();
    const body = pr.body;

    // Target verification: PASSED, never NOT VERIFIED.
    const targetSection = body.split("### Target verification")[1].split("### Regression suite")[0];
    expect(targetSection).toContain("- Scenario: `applies a discount code to the order total`");
    expect(targetSection).toContain("- Test: `tests/orders.test.ts`");
    expect(targetSection).toContain("- Result: PASSED");
    expect(body).not.toContain("NOT VERIFIED");
    expect(body).not.toMatch(/Target verification[\s\S]{0,40}NOT VERIFIED/);

    // Regression suite: FAILED with exactly the three unrelated failures.
    const regression = body.split("### Regression suite")[1].split("### HUBRIS provenance")[0];
    expect(regression).toContain("- Result: FAILED");
    expect(regression).toContain("Unrelated failures: 3");
    for (const f of THREE_FAILURES) expect(regression).toContain(`- \`${f}\``);
    expect(regression).not.toContain("tests/decoy.test.ts");
    expect(regression).not.toContain("tests/orders.test.ts");

    // Provenance bound to the exact run being shipped.
    expect(body).toContain(`- Investigation ID: \`${INVESTIGATION_ID}\``);
    expect(body).toContain(`- Forge run: \`${FORGE_RUN_ID}\``);
    expect(body).toContain(`- Analyzed commit: \`${ANALYZED}\``);
    expect(body).toContain(`- Execution commit: \`${EXECUTION}\``);
    expect(body).toContain(`- Canonical patch SHA: \`${PATCH_SHA}\``);
    expect(body).toContain("- Assessment: `REPAIR_VERIFIED`");
    expect(body).not.toContain("forge-run-decoy");

    // Existing safety properties still hold on the real route.
    expect(pr.base).toBe("main");
    expect(pr.head.startsWith("hubris/fix/")).toBe(true);
    expect(pr.title).toContain("createOrder");
    expect(JSON.stringify(githubCalls)).not.toContain("test-token-not-real");
  });

  it("pushes only the hubris/* branch (no force, no default branch) with the verified patch", async () => {
    RESULT = { forgeRuns: [forgeRun()], investigationRuns: [INVESTIGATION] };
    const res = await ship();
    expect(res.status).toBe(200);
    const pr = prCreation();

    const pushes = gitCalls.filter((a) => a[0] === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(["push", "origin", `HEAD:refs/heads/${pr.head}`]);
    expect(gitCalls.flat().some((a) => a === "--force" || a === "-f" || a.startsWith("--force"))).toBe(false);
    expect(gitCalls.some((a) => a[0] === "apply")).toBe(true);
  });

  describe("eligibility gate: REPAIR_VERIFIED needs a confirmed target pass", () => {
    async function expectBlocked(run: Record<string, unknown>) {
      RESULT = { forgeRuns: [run], investigationRuns: [INVESTIGATION] };
      const res = await ship();
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string; state: string };
      expect(data.state).toBe("NOT_READY");
      expect(data.error).toContain("Target verification must pass");
      // Zero side effects: no push, no PR, no GitHub write, no git at all.
      expect(gitCalls.filter((a) => a[0] === "push")).toHaveLength(0);
      expect(gitCalls).toHaveLength(0);
      expect(githubCalls.filter((c) => c.method !== "GET")).toHaveLength(0);
      expect(githubCalls).toHaveLength(0);
    }

    it("targetVerificationPassed === true proceeds through the ship flow", async () => {
      RESULT = { forgeRuns: [forgeRun()], investigationRuns: [INVESTIGATION] };
      const res = await ship();
      expect(res.status).toBe(200);
      expect(prCreation().body).toContain("- Result: PASSED");
      expect(gitCalls.filter((a) => a[0] === "push")).toHaveLength(1);
    });

    it("targetVerificationPassed === false is rejected", async () => {
      await expectBlocked(forgeRun({}, { targetVerificationPassed: false }));
    });

    it("a missing targetVerificationPassed signal is rejected", async () => {
      await expectBlocked(forgeRun({}, { targetVerificationPassed: undefined }));
    });

    it("targetVerificationPassed === null is rejected", async () => {
      await expectBlocked(forgeRun({}, { targetVerificationPassed: null }));
    });

    it("a passing raw targetVerification record cannot override a missing/false assessment", async () => {
      const rawPass = {
        scenario: "applies a discount code to the order total",
        testFile: "tests/orders.test.ts",
        ran: true,
        exitCode: 0,
        passed: true,
      };
      await expectBlocked(forgeRun({ targetVerification: rawPass }, { targetVerificationPassed: undefined }));
      githubCalls.length = 0;
      await expectBlocked(forgeRun({ targetVerification: rawPass }, { targetVerificationPassed: false }));
    });

    it("a failing raw record cannot override a confirmed assessment pass", async () => {
      RESULT = {
        forgeRuns: [forgeRun({ targetVerification: { scenario: "x", testFile: "y.test.ts", passed: false } })],
        investigationRuns: [INVESTIGATION],
      };
      const res = await ship();
      expect(res.status).toBe(200);
      const body = prCreation().body;
      expect(body).toContain("- Result: PASSED");
      expect(body).not.toContain("NOT VERIFIED");
    });

    it("REPAIR_NOT_VERIFIED is still blocked with zero side effects", async () => {
      RESULT = {
        forgeRuns: [forgeRun({}, { state: "REPAIR_NOT_VERIFIED", targetVerificationPassed: false })],
        investigationRuns: [INVESTIGATION],
      };
      const res = await ship();
      expect(res.status).toBe(409);
      expect(gitCalls).toHaveLength(0);
      expect(githubCalls).toHaveLength(0);
    });
  });

  describe("FULL_SUITE_PASSED semantics are preserved", () => {
    const full = (target: boolean | null | undefined) =>
      forgeRun(
        {},
        { state: "FULL_SUITE_PASSED", fullSuitePassed: true, unrelatedTestFailures: 0, failedTests: [], targetVerificationPassed: target }
      );

    it("ships with a confirmed target pass and reports a passing regression suite", async () => {
      RESULT = { forgeRuns: [full(true)], investigationRuns: [INVESTIGATION] };
      expect((await ship()).status).toBe(200);
      const body = prCreation().body;
      expect(body).toContain("- Assessment: `FULL_SUITE_PASSED`");
      expect(body).toContain("### Regression suite\n\n- Result: PASSED");
      expect(body).not.toContain("Unrelated failures");
    });

    it("still ships when no targeted run existed (the whole suite proves it)", async () => {
      RESULT = { forgeRuns: [full(null)], investigationRuns: [INVESTIGATION] };
      expect((await ship()).status).toBe(200);
      expect(gitCalls.filter((a) => a[0] === "push")).toHaveLength(1);
    });

    it("is blocked when the target explicitly failed", async () => {
      RESULT = { forgeRuns: [full(false)], investigationRuns: [INVESTIGATION] };
      expect((await ship()).status).toBe(409);
      expect(gitCalls).toHaveLength(0);
      expect(githubCalls).toHaveLength(0);
    });
  });
});

// Reproduction of the false block: a repair analyzed on a NON-default branch
// (kaiser1x/ts-js-dummy @ hubris/buggy-idempotency) used to be rejected with
// "Repository changed since this repair was verified" because SHIP compared the
// repository DEFAULT branch's SHA with the commit analyzed on the other branch.
describe("POST /api/ship — source freshness, PR base, base compatibility", () => {
  const REF = "hubris/buggy-idempotency";
  const MAIN_SHA = "4b".repeat(20);
  const MOVED = "9f".repeat(20);

  const onBranch = (over: Record<string, unknown> = {}) => {
    const base = forgeRun();
    return forgeRun({
      source: { ...(base.source as object), ref: REF, analysisRef: REF },
      ...over,
    });
  };
  const useRun = (run: Record<string, unknown>) => {
    RESULT = { forgeRuns: [run], investigationRuns: [INVESTIGATION], ref: REF };
  };
  const shipWith = async (extra: Record<string, unknown> = {}) => {
    const { app } = await import("../src/app");
    const res = await app.request("/api/ship", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: JOB_ID, forgeRunId: FORGE_RUN_ID, ...extra }),
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  const pushes = () => gitCalls.filter((a) => a[0] === "push");
  const prPosts = () => githubCalls.filter((c) => c.method === "POST");

  it("unchanged non-default ref + a DIFFERENT main SHA ships, with the PR based on the analyzed ref", async () => {
    remoteHeads = { [REF]: ANALYZED, main: MAIN_SHA };
    useRun(onBranch());
    const res = await shipWith();
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.state).toBe("PR_CREATED");
    // The GitHub API received exactly the analyzed ref as the base, never main.
    expect(prCreation().base).toBe(REF);
    expect(res.data.baseBranch).toBe(REF);
    expect(res.data.analysisRef).toBe(REF);
    expect(res.data.pullRequest.baseBranch).toBe(REF);
    expect(pushes()).toHaveLength(1);
    // main was never used as proof of freshness.
    expect(gitCalls.some((a) => a[0] === "ls-remote" && a[a.length - 1] === "refs/heads/main")).toBe(false);
  });

  it("a moved analysis ref is rejected (409) with no push and no PR, even if main equals the analyzed commit", async () => {
    remoteHeads = { [REF]: MOVED, main: ANALYZED };
    useRun(onBranch());
    const res = await shipWith();
    expect(res.status).toBe(409);
    expect(res.data.state).toBe("NOT_READY");
    expect(res.data.error).toContain("Repository changed since this repair was verified");
    expect(res.data.error).toContain(REF);
    expect(pushes()).toHaveLength(0);
    expect(prPosts()).toHaveLength(0);
  });

  it("never substitutes the default branch: requesting main when it differs is rejected as not validated", async () => {
    remoteHeads = { [REF]: ANALYZED, main: MAIN_SHA };
    useRun(onBranch());
    const res = await shipWith({ baseBranch: "main" });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe("BASE_NOT_VALIDATED");
    expect(res.data.error).toMatch(/not been validated/i);
    expect(res.data.error).toContain(REF);
    expect(pushes()).toHaveLength(0);
    expect(prPosts()).toHaveLength(0);
  });

  it("an alternative base at the very commit that was validated is allowed and passed to GitHub", async () => {
    remoteHeads = { [REF]: ANALYZED, main: ANALYZED };
    useRun(onBranch());
    const res = await shipWith({ baseBranch: "main" });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(prCreation().base).toBe("main");
    expect(res.data.baseBranch).toBe("main");
    expect(res.data.analysisRef).toBe(REF);
  });

  it("an unsafe requested base is refused before any git or GitHub write", async () => {
    remoteHeads = { [REF]: ANALYZED };
    useRun(onBranch());
    const res = await shipWith({ baseBranch: "--upload-pack=evil" });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe("BASE_INVALID");
    expect(gitCalls).toHaveLength(0);
    expect(prPosts()).toHaveLength(0);
  });

  it("a legacy run with no recorded ref uses the repository default branch as both source and base", async () => {
    remoteHeads = { main: ANALYZED };
    RESULT = { forgeRuns: [forgeRun()], investigationRuns: [INVESTIGATION] };
    const res = await shipWith();
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(prCreation().base).toBe("main");
    remoteHeads = { main: MOVED };
    githubCalls.length = 0;
    gitCalls.length = 0;
    expect((await shipWith()).status).toBe(409);
    expect(pushes()).toHaveLength(0);
  });

  it("analyzed and execution refs that differ are a provenance failure", async () => {
    remoteHeads = { [REF]: ANALYZED };
    const base = forgeRun();
    useRun(forgeRun({ source: { ...(base.source as object), ref: REF, analysisRef: "some-other-branch" } }));
    const res = await shipWith();
    expect(res.status).toBe(409);
    expect(pushes()).toHaveLength(0);
    expect(prPosts()).toHaveLength(0);
  });

  it("existing protections still hold on a non-default branch (unverified target, tampered patch)", async () => {
    remoteHeads = { [REF]: ANALYZED, main: MAIN_SHA };
    useRun(onBranch({}));
    const unverified = JSON.parse(JSON.stringify(onBranch())) as any;
    delete unverified.verification.assessment.targetVerificationPassed;
    useRun(unverified);
    const a = await shipWith();
    expect(a.status).toBe(409);
    expect(a.data.error).toMatch(/Target verification must pass/);
    const tampered = JSON.parse(JSON.stringify(onBranch())) as any;
    tampered.canonicalPatch.content += "\n+tampered\n";
    useRun(tampered);
    expect((await shipWith()).status).toBe(409);
    expect(pushes()).toHaveLength(0);
    expect(prPosts()).toHaveLength(0);
  });
});

describe("POST /api/ship on a runtime without git", () => {
  it("answers 503 GIT_UNAVAILABLE (a runtime problem, not 'repository changed') and creates nothing", async () => {
    RESULT = { forgeRuns: [forgeRun()], investigationRuns: [INVESTIGATION] };
    gitMissing = true;
    const res = await ship();
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string; code: string; state: string };
    expect(data.code).toBe("GIT_UNAVAILABLE");
    expect(data.state).toBe("NOT_READY");
    expect(data.error).toMatch(/no git binary/);
    expect(data.error).not.toContain("Repository changed");
    expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    expect(githubCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
