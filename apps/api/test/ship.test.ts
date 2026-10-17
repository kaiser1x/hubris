import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPullRequestTitle,
  buildPullRequestBody,
  buildPullRequestBodyFromRun,
  createGitHubPullRequest,
  findExistingPullRequest,
  githubTokenFromEnv,
  isSafeShipBranch,
  parseRemoteBranchSha,
  redactSecrets,
  resolveShipBase,
  shipBranchName,
  shipEligibility,
  shipForgeRun,
  sha256Hex,
  slugify,
  targetVerificationForBody,
  uniqueShipBranch,
  verifyCanonicalPatch,
  verifyShipProvenance,
  type ForgeRunLike,
  type ShipDeps,
} from "../src/ship";
import { parseCanonicalPatchContent, buildStructuredScript, CANONICAL_B64_MARKER } from "../src/structured";

const PATCH = [
  "diff --git a/src/orders.ts b/src/orders.ts",
  "--- a/src/orders.ts",
  "+++ b/src/orders.ts",
  "@@ -1 +1 @@",
  "-  total = subtotal",
  "+  total = applyDiscount(subtotal, discountCode)",
  "",
].join("\n");
const PATCH_SHA = sha256Hex(PATCH);
const PATCH_BYTES = Buffer.byteLength(PATCH, "utf-8");
const COMMIT = "a".repeat(40);
const BRANCH = "hubris/fix/create-order-discount-abcd1234";

function verifiedRun(over: Partial<ForgeRunLike> = {}): ForgeRunLike {
  return {
    id: "run-1",
    investigationId: "inv-1",
    apply: { applied: true },
    verification: {
      assessment: {
        state: "REPAIR_VERIFIED",
        patchApplied: true,
        targetVerificationPassed: true,
        fullSuitePassed: false,
        unrelatedTestFailures: 3,
        failedTests: ["tests/cart.test.ts"],
      },
    },
    targetVerification: { scenario: "applies a discount code", testFile: "tests/orders.test.ts", passed: true },
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

describe("canonical patch integrity", () => {
  it("accepts a patch whose SHA and byte count match its content", () => {
    const r = verifyCanonicalPatch({ sha: PATCH_SHA, bytes: PATCH_BYTES, content: PATCH });
    expect(r.ok).toBe(true);
    expect(r.content).toBe(PATCH);
  });

  it("fails closed on missing content, SHA mismatch, and byte mismatch", () => {
    expect(verifyCanonicalPatch({ sha: PATCH_SHA, bytes: PATCH_BYTES }).ok).toBe(false);
    expect(verifyCanonicalPatch({ sha: "0".repeat(64), bytes: PATCH_BYTES, content: PATCH }).ok).toBe(false);
    expect(verifyCanonicalPatch({ sha: PATCH_SHA, bytes: 1, content: PATCH }).ok).toBe(false);
    expect(verifyCanonicalPatch(null).ok).toBe(false);
  });
});

describe("ship eligibility", () => {
  it("allows REPAIR_VERIFIED and FULL_SUITE_PASSED", () => {
    expect(shipEligibility(verifiedRun()).ok).toBe(true);
    const full = verifiedRun({ verification: { assessment: { state: "FULL_SUITE_PASSED", targetVerificationPassed: true, fullSuitePassed: true } } });
    expect(shipEligibility(full).ok).toBe(true);
  });

  it("rejects non-eligible assessments, unapplied patches, and missing patches", () => {
    for (const state of ["REPAIR_NOT_VERIFIED", "VERIFICATION_INCOMPLETE"]) {
      expect(shipEligibility(verifiedRun({ verification: { assessment: { state } } })).ok).toBe(false);
    }
    expect(shipEligibility(verifiedRun({ apply: { applied: false } })).ok).toBe(false);
    expect(shipEligibility(verifiedRun({ canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES } })).ok).toBe(false);
    expect(shipEligibility(verifiedRun({ verification: { assessment: { state: "REPAIR_VERIFIED", targetVerificationPassed: false } } })).ok).toBe(false);
  });

  it("REPAIR_VERIFIED requires targetVerificationPassed === true (fail closed)", () => {
    const withTarget = (v: unknown) =>
      verifiedRun({
        verification: { assessment: { state: "REPAIR_VERIFIED", targetVerificationPassed: v } },
        // A passing raw record must never be used to infer a pass.
        targetVerification: { scenario: "s", testFile: "t.test.ts", passed: true },
      });
    expect(shipEligibility(withTarget(true)).ok).toBe(true);
    expect(shipEligibility(withTarget(false)).ok).toBe(false);
    for (const v of [null, undefined, "true", 1]) {
      const r = shipEligibility(withTarget(v));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("Target verification must pass");
    }
    const noField = verifiedRun({ verification: { assessment: { state: "REPAIR_VERIFIED" } } });
    expect(shipEligibility(noField).ok).toBe(false);
  });

  it("FULL_SUITE_PASSED keeps its semantics: null target ok, explicit false blocked", () => {
    const full = (v: unknown) =>
      verifiedRun({ verification: { assessment: { state: "FULL_SUITE_PASSED", fullSuitePassed: true, targetVerificationPassed: v } } });
    expect(shipEligibility(full(null)).ok).toBe(true);
    expect(shipEligibility(full(undefined)).ok).toBe(true);
    expect(shipEligibility(full(true)).ok).toBe(true);
    expect(shipEligibility(full(false)).ok).toBe(false);
  });

  it("rejects legacy runs without an assessment and generic FAILED runs", () => {
    expect(shipEligibility({ apply: { applied: true }, canonicalPatch: { sha: PATCH_SHA, bytes: PATCH_BYTES, content: PATCH } }).ok).toBe(false);
    expect(shipEligibility({ status: "FAILED" }).ok).toBe(false);
    expect(shipEligibility(verifiedRun({ verification: { assessment: { state: "FAILED" } } })).ok).toBe(false);
  });
});

describe("provenance gate", () => {
  const ctx = { repository: "kaiser1x/test2-codebase", jobRepoUrl: "https://github.com/kaiser1x/test2-codebase.git", investigationId: "inv-1" };

  it("passes when repository, investigation, and commit binding agree", () => {
    expect(verifyShipProvenance(verifiedRun(), ctx).ok).toBe(true);
  });

  it("fails closed on repository, investigation, and commit mismatches", () => {
    expect(verifyShipProvenance(verifiedRun(), { ...ctx, repository: "other/repo" }).ok).toBe(false);
    expect(verifyShipProvenance(verifiedRun(), { ...ctx, investigationId: "inv-2" }).ok).toBe(false);
    expect(verifyShipProvenance(verifiedRun({ investigationId: null }), ctx).ok).toBe(false);
    expect(
      verifyShipProvenance(verifiedRun({ source: { repoUrl: ctx.jobRepoUrl, analysisCommitSha: COMMIT, executionCommitSha: "b".repeat(40) } }), ctx).ok
    ).toBe(false);
    expect(
      verifyShipProvenance(verifiedRun({ source: { repoUrl: ctx.jobRepoUrl } }), ctx).ok
    ).toBe(false);
  });
});

describe("branch safety", () => {
  it("builds a deterministic hubris/* slug from function + report + id", () => {
    const name = shipBranchName("createOrder", "discount code makes the total wrong", "ab12cd34-ef56");
    expect(name.startsWith("hubris/fix/create-order-")).toBe(true);
    expect(name.endsWith("-ab12cd34")).toBe(true);
    expect(isSafeShipBranch(name)).toBe(true);
  });

  it("sanitizes shell metacharacters and spaces out of branch names", () => {
    const name = shipBranchName("create$(rm -rf /)Order", "a; rm -rf / #`whoami`", "x/y z");
    expect(isSafeShipBranch(name)).toBe(true);
    expect(name).not.toContain(" ");
    expect(name).not.toContain(";");
    expect(name).not.toContain("$");
    expect(name).not.toContain("`");
    expect(name).not.toContain("#");
  });

  it("rejects non-hubris branches and traversal", () => {
    expect(isSafeShipBranch("main")).toBe(false);
    expect(isSafeShipBranch("feature/x")).toBe(false);
    expect(isSafeShipBranch("hubris/../etc")).toBe(false);
    expect(isSafeShipBranch("hubris/ fix")).toBe(false);
  });

  it("collision-safe suffixing", () => {
    const existing = ["hubris/fix/x", "hubris/fix/x-1"];
    expect(uniqueShipBranch("hubris/fix/x", existing)).toBe("hubris/fix/x-2");
  });

  it("slugify is bounded and safe", () => {
    expect(slugify("Some BUG: total is $WRONG!", 3)).toBe("some-bug-total");
  });
});

describe("deterministic PR metadata", () => {
  it("builds a title from the target and report", () => {
    expect(buildPullRequestTitle("createOrder", "fixed the save10 discount")).toBe(
      "Fix createOrder: fixed the save10 discount"
    );
  });

  it("discloses regression failures and never claims the suite passed", () => {
    const body = buildPullRequestBody({
      repoName: "kaiser1x/test2-codebase",
      targetFunction: "createOrder",
      targetFile: "src/orders.ts",
      currentBehavior: "SAVE10 charges the full subtotal.",
      expectedBehavior: "expect(order.total).toBe(1350)",
      targetVerification: { scenario: "applies a discount code to the order total", testFile: "tests/orders.test.ts", passed: true },
      regression: { fullSuitePassed: false, unrelatedTestFailures: 3, failedTests: ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"] },
      provenance: {
        investigationId: "inv-1",
        forgeRunId: "run-1",
        analyzedCommitSha: COMMIT,
        executionCommitSha: COMMIT,
        canonicalPatchSha: PATCH_SHA,
        assessment: "REPAIR_VERIFIED",
      },
    });
    expect(body).toContain("## HUBRIS Repair");
    expect(body).toContain("- Result: PASS");
    expect(body).toContain("- Result: FAILED");
    expect(body).toContain("Unrelated failures: 3");
    expect(body).toContain("tests/cart.test.ts");
    expect(body).toContain("Investigation ID: `inv-1`");
    expect(body).toContain("Canonical patch SHA: `" + PATCH_SHA + "`");
    expect(body).not.toContain("pre-existing");
    expect(body).not.toMatch(/full suite.*pass/i);
  });

  it("says PASSED only when the full suite actually passed", () => {
    const body = buildPullRequestBody({
      repoName: "r",
      targetFunction: "f",
      targetFile: "f.ts",
      currentBehavior: "",
      expectedBehavior: "",
      targetVerification: { scenario: null, testFile: null, passed: true },
      regression: { fullSuitePassed: true, unrelatedTestFailures: 0, failedTests: [] },
      provenance: { investigationId: "i", forgeRunId: "r", analyzedCommitSha: COMMIT, executionCommitSha: COMMIT, canonicalPatchSha: PATCH_SHA, assessment: "FULL_SUITE_PASSED" },
    });
    expect(body).toContain("- Result: PASSED");
    expect(body).not.toContain("Unrelated:");
  });
});

describe("duplicate PR safety", () => {
  it("finds an existing HUBRIS PR for the same repo/investigation/patch", () => {
    const runs = [{ id: "run-1", pullRequest: { repository: "o/r", investigationId: "inv-1", canonicalPatchSha: PATCH_SHA, prUrl: "u" } }];
    expect(findExistingPullRequest(runs, { repository: "o/r", investigationId: "inv-1", canonicalPatchSha: PATCH_SHA })?.prUrl).toBe("u");
    expect(findExistingPullRequest(runs, { repository: "o/r", investigationId: "inv-2", canonicalPatchSha: PATCH_SHA })).toBeNull();
  });
});

describe("credentials", () => {
  it("reads only GITHUB_TOKEN and redacts it everywhere", () => {
    expect(githubTokenFromEnv({})).toBeNull();
    expect(githubTokenFromEnv({ GITHUB_TOKEN: "  secret-token  " })).toBe("secret-token");
    const scrubbed = redactSecrets("https://x-access-token:secret-token@github.com/o/r.git Bearer secret-token", "secret-token");
    expect(scrubbed).not.toContain("secret-token");
    expect(scrubbed).toContain("<redacted>");
  });
});

// ---- orchestration (injected git/fetch/fs) ----

interface Recorded {
  calls: string[][];
}

function makeDeps(over: {
  diffCached?: string;
  nameOnly?: string;
  revParse?: string;
  // `git ls-remote origin refs/heads/<hubris branch>` output.
  lsRemote?: string;
  // Remote heads by name for every OTHER ref (default: each points at COMMIT).
  heads?: Record<string, string>;
  fail?: (args: string[]) => string | null;
} = {}): ShipDeps & Recorded {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const failure = over.fail?.(args);
    if (failure) throw new Error(failure);
    if (args[0] === "diff" && args.includes("--cached") && !args.includes("--check")) {
      return { stdout: over.diffCached ?? PATCH, stderr: "" };
    }
    if (args[0] === "diff" && args.includes("--name-only")) {
      return { stdout: over.nameOnly ?? "", stderr: "" };
    }
    if (args[0] === "rev-parse") return { stdout: (over.revParse ?? COMMIT) + "\n", stderr: "" };
    if (args[0] === "ls-remote") {
      const ref = args[args.length - 1];
      if (ref === `refs/heads/${BRANCH}`) return { stdout: over.lsRemote ?? "", stderr: "" };
      if (ref.startsWith("refs/tags/")) return { stdout: "", stderr: "" };
      const name = ref.replace(/^refs\/heads\//, "");
      const sha = over.heads ? over.heads[name] : COMMIT;
      return { stdout: sha ? `${sha}\t${ref}\n` : "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/o/r/pull/42" }), { status: 201 });
  }) as unknown as typeof fetch;
  return {
    calls,
    exec,
    fetchImpl,
    tmpDir: async () => "/tmp/hubris-ship-test",
    removeDir: async () => undefined,
    writeFile: async () => undefined,
  };
}

const SHIP_INPUT = {
  repository: "kaiser1x/test2-codebase",
  owner: "kaiser1x",
  commitSha: COMMIT,
  analysisRef: "main",
  baseBranch: "main",
  branch: BRANCH,
  patchContent: PATCH,
  canonicalPatchSha: PATCH_SHA,
  title: "Fix createOrder: discount",
  body: "body",
  token: "secret-token",
};

describe("shipForgeRun orchestration", () => {
  it("pushes only a hubris/* branch (never force, never the base) and creates a PR", async () => {
    const deps = makeDeps();
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(result.pullRequest?.prUrl).toContain("/pull/42");
    const push = deps.calls.find((a) => a[0] === "push");
    expect(push).toBeDefined();
    expect(push).toContain(`HEAD:refs/heads/${BRANCH}`);
    expect(push).not.toContain("--force");
    expect(push?.join(" ")).not.toContain("main");
  });

  it("fails closed when the reproduced patch SHA does not match", async () => {
    const deps = makeDeps({ diffCached: PATCH + "extra" });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the verified canonical patch");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
  });

  it("fails closed when the analyzed ref advanced", async () => {
    const deps = makeDeps({ heads: { main: "b".repeat(40) } });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Repository changed since this repair was verified");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
  });

  it("fails closed when the analyzed commit no longer exists", async () => {
    const deps = makeDeps({ fail: (args) => (args[0] === "fetch" ? "fatal: couldn't find remote ref" : null) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Repository changed since this repair was verified");
  });

  it("fails closed on unexpected working-tree changes", async () => {
    const deps = makeDeps({ nameOnly: "src/other.ts" });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unexpected working-tree changes");
  });

  it("fails closed on push rejection, without leaking the token", async () => {
    const deps = makeDeps({ fail: (args) => (args[0] === "push" ? "rejected secret-token" : null) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("secret-token");
  });

  it("refuses unsafe branch names before any git work", async () => {
    const deps = makeDeps();
    const result = await shipForgeRun({ ...SHIP_INPUT, branch: "main" }, deps);
    expect(result.ok).toBe(false);
    expect(deps.calls).toHaveLength(0);
  });

  it("reports an existing open PR instead of creating a duplicate", async () => {
    const deps = makeDeps();
    deps.fetchImpl = (async (url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/o/r/pull/7" }]), { status: 200 })
        : new Response("{}", { status: 201 })) as unknown as typeof fetch;
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(result.duplicate?.prNumber).toBe(7);
    expect(result.pullRequest).toBeUndefined();
  });
});

describe("GitHub API is minimal and non-destructive", () => {
  it("creates a PR via POST and surfaces errors without credentials", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    );
    const res = await createGitHubPullRequest("secret-token", "o/r", { title: "t", body: "b", head: "hubris/x", base: "main" }, fetchMock as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("secret-token");
  });

  it("never issues a DELETE or archive request", () => {
    const SRC = fileURLToPath(new URL("../src/ship.ts", import.meta.url));
    const source = readFileSync(SRC, "utf8");
    expect(source).not.toContain('"DELETE"');
    expect(source).not.toContain("/git/refs");
    expect(source).not.toContain("/archive");
    expect(source).not.toContain('"--force"');
  });
});

describe("canonical patch capture", () => {
  it("the structured script echoes the canonical patch and it decodes byte-exact", () => {
    const script = buildStructuredScript("pnpm", [], "pnpm test");
    expect(script).toContain(CANONICAL_B64_MARKER);
    const stdout = `noise\n${CANONICAL_B64_MARKER} ${Buffer.from(PATCH, "utf-8").toString("base64")}\n`;
    expect(parseCanonicalPatchContent(stdout)).toBe(PATCH);
    expect(parseCanonicalPatchContent("no marker")).toBeNull();
  });
});

describe("parseRemoteBranchSha", () => {
  it("reads only the exact branch row", () => {
    expect(parseRemoteBranchSha(`${COMMIT}\trefs/heads/${BRANCH}\n`, BRANCH)).toBe(COMMIT);
    expect(parseRemoteBranchSha(`${COMMIT}\trefs/heads/other\n`, BRANCH)).toBeNull();
    expect(parseRemoteBranchSha("", BRANCH)).toBeNull();
    expect(parseRemoteBranchSha("garbage", BRANCH)).toBeNull();
  });
});

describe("idempotent push and remote conflict", () => {
  const ls = (sha: string) => `${sha}\trefs/heads/${BRANCH}\n`;

  it("branch absent → pushes normally", async () => {
    const deps = makeDeps({ lsRemote: "" });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(result.pushStatus).toBe("PUSHED");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(true);
  });

  it("branch exists with the same SHA → treated as already pushed (no push, no pull)", async () => {
    const deps = makeDeps({ lsRemote: ls(COMMIT) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(result.pushStatus).toBe("ALREADY_PUSHED");
    expect(result.pullRequest?.prUrl).toContain("/pull/42");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
    expect(deps.calls.some((a) => a[0] === "pull")).toBe(false);
  });

  it("branch exists with a different SHA → blocked conflict (no push, no pull, no force)", async () => {
    const deps = makeDeps({ lsRemote: ls("c".repeat(40)) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("conflict");
    expect(result.reason).toContain("already contains different work");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
    expect(deps.calls.some((a) => a[0] === "pull")).toBe(false);
    expect(deps.calls.flat()).not.toContain("--force");
  });

  it("403 on PR creation → authorization required (action required)", async () => {
    const deps = makeDeps();
    deps.fetchImpl = (async (url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([]), { status: 200 })
        : new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 })) as unknown as typeof fetch;
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("auth");
    expect(result.reason).toContain("authorization required");
    expect(result.reason).not.toContain("secret-token");
  });

  it("existing PR is detected and no duplicate is created", async () => {
    const deps = makeDeps();
    let postCalls = 0;
    deps.fetchImpl = (async (url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/o/r/pull/7" }]), { status: 200 })
        : (postCalls++, new Response("{}", { status: 201 }))) as unknown as typeof fetch;
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.duplicate?.prNumber).toBe(7);
    expect(result.pullRequest).toBeUndefined();
    expect(postCalls).toBe(0);
  });
});

// The PR body must reflect the FINAL Forge target-verification result, not the
// stale/unpopulated raw persisted record.
describe("PR body target verification uses the final assessment", () => {
  const provenance = {
    investigationId: "inv-1",
    forgeRunId: "run-1",
    analyzedCommitSha: COMMIT,
    executionCommitSha: COMMIT,
    canonicalPatchSha: PATCH_SHA,
    assessment: "REPAIR_VERIFIED",
  };

  it("a verified run whose raw record lacks `passed` still reports PASSED", () => {
    // The real persisted targetVerification has scenario/testFile/ran/exitCode/
    // timedOut but NOT `passed` — the final result lives in the assessment.
    const run = verifiedRun({
      targetVerification: { scenario: "applies a discount code to the order total", testFile: "tests/orders.test.ts" },
    });
    const tv = targetVerificationForBody(run);
    expect(tv.passed).toBe(true);
    expect(tv.scenario).toBe("applies a discount code to the order total");
    expect(tv.testFile).toBe("tests/orders.test.ts");

    const body = buildPullRequestBody({
      repoName: "kaiser1x/test2-codebase",
      targetFunction: "createOrder",
      targetFile: "src/orders.ts",
      currentBehavior: "A customer applies the SAVE10 discount, but createOrder charges the full subtotal.",
      expectedBehavior: "expect(order.total).toBe(1350)",
      targetVerification: tv,
      regression: {
        fullSuitePassed: false,
        unrelatedTestFailures: 3,
        failedTests: ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"],
      },
      provenance,
    });
    expect(body).toContain("- Scenario: `applies a discount code to the order total`");
    expect(body).toContain("- Test: `tests/orders.test.ts`");
    expect(body).toContain("- Result: PASSED");
    expect(body).not.toContain("NOT VERIFIED");
    expect(body).toContain("- Result: FAILED");
    expect(body).toContain("Unrelated failures: 3");
    expect(body).toContain("- `tests/cart.test.ts`");
    expect(body).toContain("- `tests/users.test.ts`");
    expect(body).toContain("- `tests/sessions.test.ts`");
    expect(body).toContain("Assessment: `REPAIR_VERIFIED`");
    expect(body).toContain(`Investigation ID: \`inv-1\``);
    expect(body).toContain(`Canonical patch SHA: \`${PATCH_SHA}\``);
  });

  it("a run whose final target verification failed reports NOT VERIFIED", () => {
    const run = verifiedRun({
      verification: { assessment: { state: "REPAIR_NOT_VERIFIED", targetVerificationPassed: false } },
    });
    const tv = targetVerificationForBody(run);
    expect(tv.passed).toBe(false);
    const body = buildPullRequestBody({
      repoName: "o/r",
      targetFunction: "createOrder",
      targetFile: "src/orders.ts",
      currentBehavior: "",
      expectedBehavior: "",
      targetVerification: tv,
      regression: { fullSuitePassed: false, unrelatedTestFailures: 0, failedTests: [] },
      provenance: { ...provenance, assessment: "REPAIR_NOT_VERIFIED" },
    });
    expect(body).toContain("- Result: NOT VERIFIED");
  });

  describe("buildPullRequestBodyFromRun (exact finalized Forge run)", () => {
    const ctx = {
      repoName: "kaiser1x/test2-codebase",
      targetFunction: "createOrder",
      targetFile: "src/orders.ts",
      currentBehavior: "A customer applies the SAVE10 discount, but createOrder charges the full subtotal.",
      expectedBehavior: "expect(order.total).toBe(1350)",
      investigationId: "inv-1",
      forgeRunId: "run-1",
      analyzedCommitSha: COMMIT,
      executionCommitSha: COMMIT,
      canonicalPatchSha: PATCH_SHA,
    };
    const finalRun = (over: Partial<ForgeRunLike> = {}) =>
      verifiedRun({
        // Stale raw record: no `passed`, and the old NOT-verified shape would
        // have produced "Result: NOT VERIFIED".
        targetVerification: { scenario: "applies a discount code to the order total", testFile: "tests/orders.test.ts" },
        verification: {
          assessment: {
            state: "REPAIR_VERIFIED",
            patchApplied: true,
            targetVerificationPassed: true,
            targetScenario: "applies a discount code to the order total",
            targetTestFile: "tests/orders.test.ts",
            fullSuitePassed: false,
            unrelatedTestFailures: 3,
            failedTests: ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"],
          },
        },
        ...over,
      });

    it("verified run → Target verification PASSED, never NOT VERIFIED", () => {
      const body = buildPullRequestBodyFromRun(finalRun(), ctx);
      const section = body.split("### Regression suite")[0].split("### Target verification")[1];
      expect(section).toContain("- Scenario: `applies a discount code to the order total`");
      expect(section).toContain("- Test: `tests/orders.test.ts`");
      expect(section).toContain("- Result: PASSED");
      expect(body).not.toContain("Result: NOT VERIFIED");
      expect(body).not.toContain("NOT VERIFIED");
    });

    it("represents 3 unrelated regression failures", () => {
      const body = buildPullRequestBodyFromRun(finalRun(), ctx);
      const regression = body.split("### Regression suite")[1].split("### HUBRIS provenance")[0];
      expect(regression).toContain("- Result: FAILED");
      expect(regression).toContain("- Unrelated failures: 3");
      expect(regression).toContain("Unrelated:");
      expect(regression).toContain("- `tests/cart.test.ts`");
      expect(regression).toContain("- `tests/users.test.ts`");
      expect(regression).toContain("- `tests/sessions.test.ts`");
      expect(regression).not.toContain("tests/orders.test.ts");
    });

    it("includes the exact assessment and full provenance", () => {
      const body = buildPullRequestBodyFromRun(finalRun(), ctx);
      expect(body).toContain("- Investigation ID: `inv-1`");
      expect(body).toContain("- Forge run: `run-1`");
      expect(body).toContain(`- Analyzed commit: \`${COMMIT}\``);
      expect(body).toContain(`- Execution commit: \`${COMMIT}\``);
      expect(body).toContain(`- Canonical patch SHA: \`${PATCH_SHA}\``);
      expect(body).toContain("- Assessment: `REPAIR_VERIFIED`");
      expect(body).toContain("_Created by HUBRIS from a verified repair. HUBRIS did not merge this");
    });

    it("reports the exact final assessment state (FULL_SUITE_PASSED)", () => {
      const run = finalRun({
        verification: {
          assessment: { state: "FULL_SUITE_PASSED", targetVerificationPassed: true, fullSuitePassed: true },
        },
      });
      const body = buildPullRequestBodyFromRun(run, ctx);
      expect(body).toContain("- Assessment: `FULL_SUITE_PASSED`");
      expect(body).toContain("### Regression suite\n\n- Result: PASSED");
      expect(body).not.toContain("Unrelated failures");
    });

    it("the final assessment wins over a stale raw record", () => {
      const run = finalRun({ targetVerification: { scenario: "old", testFile: "old.test.ts", passed: false } });
      const body = buildPullRequestBodyFromRun(run, ctx);
      expect(body).toContain("- Result: PASSED");
      expect(body).toContain("- Scenario: `applies a discount code to the order total`");
      expect(body).not.toContain("NOT VERIFIED");
    });
  });

  it("the body never references an earlier/deleted PR", () => {
    const body = buildPullRequestBody({
      repoName: "o/r",
      targetFunction: "f",
      targetFile: "f.ts",
      currentBehavior: "",
      expectedBehavior: "",
      targetVerification: targetVerificationForBody(verifiedRun()),
      regression: { fullSuitePassed: true, unrelatedTestFailures: 0, failedTests: [] },
      provenance: { ...provenance, assessment: "FULL_SUITE_PASSED" },
    });
    expect(body.toLowerCase()).not.toContain("deleted");
    expect(body.toLowerCase()).not.toContain("previous pr");
  });
});


// ---- source freshness vs PR base vs base compatibility ----
//
// Three separate questions:
//   source freshness   did the EXACT ref Forge analyzed move?
//   PR base            which branch will the pull request merge into?
//   base compatibility was the repair validated against that base?
// A repair analyzed on a non-default branch used to be blocked because the
// default branch's SHA was compared with the analyzed commit.
describe("source freshness, PR base, and base compatibility", () => {
  const ANALYSIS_REF = "hubris/buggy-idempotency";
  const MAIN_SHA = "4b".repeat(20);
  const MOVED_SHA = "9f".repeat(20);

  // Ref-aware fake remote: `git ls-remote origin refs/heads/<name>` answers
  // from `heads`, `refs/tags/<name>` from `tags`.
  function refDeps(heads: Record<string, string>, tags: Record<string, string> = {}) {
    const deps = makeDeps();
    const posts: Array<Record<string, unknown>> = [];
    const baseExec = deps.exec;
    deps.exec = async (args, opts) => {
      if (args[0] === "ls-remote") {
        const ref = args[args.length - 1];
        deps.calls.push(args);
        const name = ref.replace(/^refs\/(heads|tags)\//, "");
        const table = ref.startsWith("refs/tags/") ? tags : heads;
        return { stdout: table[name] ? `${table[name]}\t${ref}\n` : "", stderr: "" };
      }
      return baseExec(args, opts);
    };
    deps.fetchImpl = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/o/r/pull/42" }), { status: 201 });
    }) as unknown as typeof fetch;
    return { deps, posts };
  }
  const input = (over: Record<string, unknown> = {}) => ({
    ...SHIP_INPUT,
    analysisRef: ANALYSIS_REF,
    baseBranch: ANALYSIS_REF,
    ...over,
  });
  const wrote = (deps: ShipDeps & Recorded) => ({
    pushed: deps.calls.some((a) => a[0] === "push"),
    pulled: deps.calls.some((a) => a[0] === "pull"),
  });

  it("an unchanged non-default analysis ref is NOT rejected because main has a different SHA", async () => {
    const { deps, posts } = refDeps({ [ANALYSIS_REF]: COMMIT, main: MAIN_SHA });
    const result = await shipForgeRun(input(), deps);
    expect(result.ok, result.reason).toBe(true);
    expect(posts).toHaveLength(1);
    // The default branch was never consulted.
    expect(deps.calls.filter((a) => a[0] === "ls-remote").map((a) => a[a.length - 1])).not.toContain("refs/heads/main");
  });

  it("the PR is created against the analyzed ref, never silently against main", async () => {
    const { deps, posts } = refDeps({ [ANALYSIS_REF]: COMMIT, main: MAIN_SHA });
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(true);
    expect(posts[0].base).toBe(ANALYSIS_REF);
    expect(posts[0].base).not.toBe("main");
    expect(result.pullRequest?.baseBranch).toBe(ANALYSIS_REF);
  });

  it("a moved analysis ref is rejected before anything is written", async () => {
    const { deps, posts } = refDeps({ [ANALYSIS_REF]: MOVED_SHA, main: COMMIT });
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Repository changed since this repair was verified");
    expect(result.reason).toContain(ANALYSIS_REF);
    expect(wrote(deps)).toEqual({ pushed: false, pulled: false });
    expect(posts).toHaveLength(0);
  });

  it("main equal to the analyzed commit does not rescue a moved analysis ref", async () => {
    const { deps } = refDeps({ [ANALYSIS_REF]: MOVED_SHA, main: COMMIT });
    const result = await shipForgeRun(input({ baseBranch: "main" }), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Repository changed since this repair was verified");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
  });

  it("an analysis ref that no longer exists is a stale source", async () => {
    const { deps } = refDeps({ main: COMMIT });
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Repository changed since this repair was verified");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
  });

  it("an analysis ref that is a tag cannot be a PR base and is not replaced by main", async () => {
    const { deps, posts } = refDeps({ main: COMMIT }, { [ANALYSIS_REF]: COMMIT });
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("base");
    expect(result.reason).toMatch(/tag/i);
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("an alternative base at a DIFFERENT commit is rejected: the repair was not validated against it", async () => {
    const { deps, posts } = refDeps({ [ANALYSIS_REF]: COMMIT, main: MAIN_SHA });
    const result = await shipForgeRun(input({ baseBranch: "main" }), deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("base");
    expect(result.reason).toContain("main");
    expect(result.reason).toMatch(/not been validated|not validated/i);
    expect(wrote(deps)).toEqual({ pushed: false, pulled: false });
    expect(posts).toHaveLength(0);
  });

  it("an alternative base at the SAME commit is the validated tree, so it is allowed and passed through", async () => {
    const { deps, posts } = refDeps({ [ANALYSIS_REF]: COMMIT, main: COMMIT });
    const result = await shipForgeRun(input({ baseBranch: "main" }), deps);
    expect(result.ok, result.reason).toBe(true);
    expect(posts[0].base).toBe("main");
  });

  it("an alternative base that does not exist is rejected", async () => {
    const { deps } = refDeps({ [ANALYSIS_REF]: COMMIT });
    const result = await shipForgeRun(input({ baseBranch: "release" }), deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("base");
    expect(result.reason).toContain("release");
  });

  it("an existing open PR for the head branch that targets a different base is a conflict, not a success", async () => {
    const { deps } = refDeps({ [ANALYSIS_REF]: COMMIT });
    deps.fetchImpl = (async (_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/o/r/pull/7", base: { ref: "main" } }]), { status: 200 })
        : new Response("{}", { status: 201 })) as unknown as typeof fetch;
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("conflict");
    expect(result.reason).toContain("main");
  });

  it("an existing open PR against the SAME base is still returned idempotently", async () => {
    const { deps } = refDeps({ [ANALYSIS_REF]: COMMIT });
    deps.fetchImpl = (async (_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([{ number: 7, html_url: "https://github.com/o/r/pull/7", base: { ref: ANALYSIS_REF } }]), { status: 200 })
        : new Response("{}", { status: 201 })) as unknown as typeof fetch;
    const result = await shipForgeRun(input(), deps);
    expect(result.ok).toBe(true);
    expect(result.duplicate?.prNumber).toBe(7);
  });

  it("rejects an unsafe base or analysis ref before any git command", async () => {
    for (const bad of ["--upload-pack=evil", "a..b", "-x", "", "a b"]) {
      const { deps } = refDeps({ [ANALYSIS_REF]: COMMIT });
      const result = await shipForgeRun(input({ baseBranch: bad }), deps);
      expect(result.ok, bad).toBe(false);
      expect(deps.calls, bad).toHaveLength(0);
    }
  });

  it("legacy behavior: with no analysis ref, the base is the analysis ref and is checked against the commit", async () => {
    const { deps, posts } = refDeps({ main: COMMIT });
    const result = await shipForgeRun(input({ analysisRef: "main", baseBranch: "main" }), deps);
    expect(result.ok).toBe(true);
    expect(posts[0].base).toBe("main");
    const moved = refDeps({ main: MOVED_SHA });
    expect((await shipForgeRun(input({ analysisRef: "main", baseBranch: "main" }), moved.deps)).ok).toBe(false);
  });
});

describe("resolveShipBase (PR base policy)", () => {
  it("defaults the base to the analyzed ref, including a non-default branch", () => {
    const r = resolveShipBase({ analysisRef: "hubris/buggy-idempotency", defaultBranch: "main", requestedBase: null });
    expect(r).toMatchObject({ ok: true, analysisRef: "hubris/buggy-idempotency", baseBranch: "hubris/buggy-idempotency", alternative: false });
  });

  it("falls back to the repository default branch only when no ref was analyzed (legacy job)", () => {
    const r = resolveShipBase({ analysisRef: null, defaultBranch: "main", requestedBase: null });
    expect(r).toMatchObject({ ok: true, analysisRef: "main", baseBranch: "main", alternative: false });
  });

  it("flags an explicit different base as an alternative (to be validated), never silently main", () => {
    const r = resolveShipBase({ analysisRef: "hubris/buggy-idempotency", defaultBranch: "main", requestedBase: "main" });
    expect(r).toMatchObject({ ok: true, baseBranch: "main", analysisRef: "hubris/buggy-idempotency", alternative: true });
  });

  it("rejects unsafe refs", () => {
    expect(resolveShipBase({ analysisRef: "-evil", defaultBranch: "main", requestedBase: null }).ok).toBe(false);
    expect(resolveShipBase({ analysisRef: "ok", defaultBranch: "main", requestedBase: "a..b" }).ok).toBe(false);
  });
});

describe("SHIP on a host without git", () => {
  const enoent = () => Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });

  it("reports a runtime problem — never 'the repository changed' — and writes nothing", async () => {
    const deps = makeDeps();
    const exec = deps.exec;
    deps.exec = async (args, opts) => {
      if (args[0] === "init" || args[0] === "remote" || args[0] === "fetch") throw enoent();
      return exec(args, opts);
    };
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("runtime");
    expect(result.reason).toContain("no git binary");
    expect(result.reason).not.toContain("Repository changed since this repair was verified");
    expect(deps.calls.some((a) => a[0] === "push")).toBe(false);
  });

  it("other git failures at that stage are still treated as a stale source", async () => {
    const deps = makeDeps({ fail: (args) => (args[0] === "fetch" ? "fatal: couldn't find remote ref" : null) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.kind).toBeUndefined();
    expect(result.reason).toContain("Repository changed since this repair was verified");
  });

  it("a failing push is redacted and never echoes the token", async () => {
    const deps = makeDeps({ fail: (args) => (args[0] === "push" ? "fatal: unable to access https://x-access-token:secret-token@github.com/o/r.git" : null) });
    const result = await shipForgeRun(SHIP_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("secret-token");
  });
});
