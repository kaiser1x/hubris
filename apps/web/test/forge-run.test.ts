// Phase J frontend tests. No live Nebius, no sandbox, no network: every
// case runs against fixture data shaped exactly like the persisted backend
// entries (verified against the real ts-js-dummy forgeRuns[] during audit).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseTestSummary,
  resolveForgeRuns,
  selectForgeEvidenceJob,
  toForgeRunView,
  buildVerifyBody,
  buildInvestigateBody,
  canForgePlan,
  composeForgeFocus,
  describeInvestigationFailure,
  findSavedInvestigation,
  describeRunStatus,
  jobSourceRef,
  shortRunStatus,
  toInvestigation,
  toLiveVerification,
  toVerifyError,
  findRunView,
  buildForgeBody,
  buildReproduceBody,
  forgeReviewHref,
  investigationReviewHref,
  STRUCTURED_VERIFY_PATH,
  LEGACY_VERIFY_PATH,
  SHIP_PATH,
  shipEligible,
  targetVerificationMark,
  shipRepairHref,
  buildShipBody,
  shipBranchPreview,
  shipTitlePreview,
} from "../app/lib/forge-run";
import ForgeRunPanel from "../app/components/ForgeRunPanel";

const HEX64 = "9eba9713e30293ec9f5225613725c07435c6e438c27bc0d60fb5964dc453647c";

function trail(...states: string[]) {
  return states.map((state) => ({ state, at: "2026-09-26T03:29:40.490Z" }));
}

function structuredRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-structured-1",
    status: "VERIFIED",
    history: trail(
      "PROPOSED",
      "EDIT_VALIDATING",
      "PATCH_VALIDATING",
      "EDIT_APPLIED",
      "APPLIED",
      "VERIFYING",
      "VERIFIED"
    ),
    generation: {
      source: "forge",
      format: "structured-edit",
      focus: "duplicate idempotency guard",
      edits: [
        {
          path: "src/payments.ts",
          function: "createPayment",
          oldTextHash: "a".repeat(64),
          newTextHash: "b".repeat(64),
        },
      ],
    },
    canonicalPatch: { sha: HEX64, bytes: 510 },
    validation: { editCategory: "ok", canonicalPresent: true, patchValidated: true },
    apply: { applied: true },
    verification: {
      command: "pnpm test",
      commandSource: "detected",
      exitCode: 0,
      timedOut: false,
      passed: true,
    },
    image: "tag:node:20-slim",
    manager: "pnpm",
    workspace: "/tmp/hubris-repo",
    files: 16,
    bytes: 61000,
    sha256: "c".repeat(64),
    durationMs: 15636,
    verified: true,
    stdout: [
      "stdout | tests/payments.test.ts (9 tests)",
      " Test Files  3 passed (3)",
      "      Tests  13 passed (13)",
    ].join("\n"),
    stderr: "",
    at: "2026-09-26T03:29:40.490Z",
    ...over,
  };
}

function diffRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-diff-1",
    status: "APPLY_FAILED",
    history: trail("PROPOSED", "APPLYING", "APPLY_FAILED"),
    patch: { source: "provided", diffSha256: "d".repeat(64), diffBytes: 200 },
    apply: { applied: false },
    verification: { command: "pnpm test", commandSource: "detected", exitCode: 128, timedOut: false, passed: false },
    image: "tag:node:20-slim",
    manager: "pnpm",
    workspace: "/tmp/hubris-repo",
    files: 16,
    bytes: 61000,
    sha256: "e".repeat(64),
    durationMs: 2521,
    verified: false,
    stdout: "",
    stderr: "error: patch failed",
    at: "2026-09-26T03:10:12.760Z",
    ...over,
  };
}

describe("resolveForgeRuns / selectForgeEvidenceJob", () => {
  it("1. no Forge runs: empty job, missing result, and malformed entries", () => {
    expect(resolveForgeRuns(null)).toEqual([]);
    expect(resolveForgeRuns({})).toEqual([]);
    expect(resolveForgeRuns({ result: null })).toEqual([]);
    expect(resolveForgeRuns({ result: {} })).toEqual([]);
    expect(resolveForgeRuns({ result: { forgeRuns: "nope" } })).toEqual([]);
    expect(resolveForgeRuns({ result: { forgeRuns: [null, 42, "x"] } })).toEqual([]);
    expect(selectForgeEvidenceJob([])).toBeNull();
    expect(selectForgeEvidenceJob(null)).toBeNull();
    expect(
      selectForgeEvidenceJob([{ id: "a", result: { forgeRuns: [] } }])
    ).toBeNull();
  });

  it("selects the latest job that actually carries runs", () => {
    const empty = { id: "new", result: { forgeRuns: [] } };
    const full = { id: "old", result: { forgeRuns: [structuredRun()] } };
    expect(selectForgeEvidenceJob([empty, full])).toBe(full);
  });
});

describe("toForgeRunView", () => {
  it("2. in-progress trail: reached steps are checked, later steps open", () => {
    const v = toForgeRunView(
      structuredRun({
        status: "APPLYING",
        history: trail("PROPOSED", "EDIT_VALIDATING", "PATCH_VALIDATING"),
        validation: { editCategory: "ok", canonicalPresent: false, patchValidated: false },
        apply: { applied: false },
        verification: null,
      }),
      1
    )!;
    expect(v.outcome).toBe("UNKNOWN");
    const reached = Object.fromEntries(v.steps.map((s) => [s.label, s.reached]));
    expect(reached["Proposed"]).toBe(true);
    expect(reached["Edit validated"]).toBe(true);
    expect(reached["Patch validated"]).toBe(false);
    expect(reached["Verified"]).toBe(false);
    expect(v.verification).toBeNull();
  });

  it("3. successful VERIFIED run: full checklist and evidence", () => {
    const v = toForgeRunView(structuredRun(), 3)!;
    expect(v.number).toBe(3);
    expect(v.kind).toBe("structured");
    expect(v.outcome).toBe("VERIFIED");
    expect(v.steps.every((s) => s.reached)).toBe(true);
    expect(v.modelSource).toBe("forge");
    expect(v.edits).toEqual([{ path: "src/payments.ts", function: "createPayment" }]);
    expect(v.patchBytes).toBe(510);
    expect(v.patchShaShort).toBe(`${HEX64.slice(0, 12)}…`);
    expect(v.applyApplied).toBe(true);
    expect(v.verification?.result).toBe("PASS");
    expect(v.testSummary).toEqual({ passed: 13, total: 13 });
  });

  it("4. apply failure: patch rejected, verification NOT RUN", () => {
    const v = toForgeRunView(diffRun(), 1)!;
    expect(v.kind).toBe("diff");
    expect(v.outcome).toBe("APPLY_FAILED");
    expect(v.applyApplied).toBe(false);
    expect(v.verification?.started).toBe(false);
    expect(v.verification?.result).toBe("NOT RUN");
    // The 128 belongs to the apply phase, not the verify command — the
    // checklist must not claim patch validation or execution happened.
    const reached = Object.fromEntries(v.steps.map((s) => [s.label, s.reached]));
    expect(reached["Patch validated"]).toBe(false);
    expect(reached["Applied"]).toBe(false);
    expect(reached["Verifying"]).toBe(false);
  });

  it("5. verification failure: exit 1 after the command started", () => {
    const v = toForgeRunView(
      structuredRun({
        status: "FAILED",
        history: trail("PROPOSED", "EDIT_VALIDATING", "PATCH_VALIDATING", "EDIT_APPLIED", "APPLIED", "VERIFYING", "FAILED"),
        verification: { command: "pnpm test", commandSource: "detected", exitCode: 1, timedOut: false, passed: false },
        verified: false,
        stdout: " Tests  11 passed (13)",
      }),
      2
    )!;
    expect(v.outcome).toBe("VERIFICATION_FAILED");
    expect(v.verification?.started).toBe(true);
    expect(v.verification?.result).toBe("FAIL");
  });

  it("6. timeout: timed-out verification is FAIL", () => {
    const v = toForgeRunView(
      structuredRun({
        status: "TIMEOUT",
        verification: { command: "pnpm test", commandSource: "detected", exitCode: null, timedOut: true, passed: false },
        verified: false,
      }),
      2
    )!;
    expect(v.outcome).toBe("VERIFICATION_TIMEOUT");
    expect(v.verification?.result).toBe("FAIL");
  });

  it("7. malformed entries yield null, never a fabricated success", () => {
    expect(toForgeRunView(null, 1)).toBeNull();
    expect(toForgeRunView("x", 1)).toBeNull();
    expect(toForgeRunView(42, 1)).toBeNull();
    const v = toForgeRunView({ nonsense: true }, 1)!;
    expect(v.outcome).toBe("UNKNOWN");
    expect(v.steps.every((s) => !s.reached)).toBe(true);
    expect(v.verification).toBeNull();
  });

  it("9. exit 0 with passed maps to PASS", () => {
    const v = toForgeRunView(structuredRun(), 1)!;
    expect(v.verification).toMatchObject({ exitCode: 0, passed: true, result: "PASS" });
  });

  it("10. non-zero exit maps to FAIL", () => {
    const v = toForgeRunView(
      structuredRun({
        status: "FAILED",
        verification: { command: "pnpm test", commandSource: "detected", exitCode: 1, timedOut: false, passed: false },
        verified: false,
      }),
      1
    )!;
    expect(v.verification?.result).toBe("FAIL");
  });
});

describe("parseTestSummary", () => {
  it("8. parses the real vitest summary shape", () => {
    expect(parseTestSummary("      Tests  13 passed (13)")).toEqual({ passed: 13, total: 13 });
    expect(
      parseTestSummary(" Test Files  3 passed (3)\n      Tests  11 passed (13)")
    ).toEqual({ passed: 11, total: 13 });
  });

  it("returns null when no summary is present", () => {
    expect(parseTestSummary("")).toBeNull();
    expect(parseTestSummary("PATCH_OK\nVERIFY_BEGIN")).toBeNull();
    expect(parseTestSummary(null as unknown as string)).toBeNull();
  });
});

describe("ForgeRunPanel", () => {
  it("renders VERIFIED with 13/13 and exit 0, no fake claims on failures", () => {
    const html = renderToStaticMarkup(
      ForgeRunPanel({ run: toForgeRunView(structuredRun(), 3)! })
    );
    expect(html).toContain("VERIFIED");
    expect(html).toContain("13 / 13");
    expect(html).toContain("pnpm test");
    expect(html).toContain("src/payments.ts");
    expect(html).toContain("createPayment()");
    expect(html).not.toContain("NOT RUN");
  });

  it("renders apply failure with NOT RUN and no success language", () => {
    const html = renderToStaticMarkup(
      ForgeRunPanel({ run: toForgeRunView(diffRun(), 1)! })
    );
    expect(html).toContain("PATCH APPLY FAILED");
    expect(html).toContain("NOT RUN");
    expect(html).not.toContain("VERIFIED");
    expect(html).not.toContain(">PASS<");
  });

  it("exposes no secrets or credentials", () => {
    const html = renderToStaticMarkup(
      ForgeRunPanel({ run: toForgeRunView(structuredRun(), 1)! })
    );
    expect(html).not.toMatch(/NEBIUS_API_KEY|NEBIUS_PROJECT_ID|GITHUB_TOKEN|DATABASE_URL|Bearer /);
  });
});

describe("VERIFY IN SANDBOX structured routing (no live model)", () => {
  it("1. the button targets the structured route, not the legacy diff route", () => {
    expect(STRUCTURED_VERIFY_PATH).toBe("/api/forge-structured");
    expect(LEGACY_VERIFY_PATH).toBe("/api/forge-verify");
    expect(STRUCTURED_VERIFY_PATH).not.toBe(LEGACY_VERIFY_PATH);
  });

  it("2. request body carries exactly job/focus for the structured contract", () => {
    const r = buildVerifyBody("job-1", "  duplicate guard missing  ");
    expect(r).toEqual({ ok: true, body: { jobId: "job-1", focus: "duplicate guard missing" } });
    // No `diff` field: the model drafts the plan, HUBRIS authors the patch.
    // The legacy direct-diff branch is therefore unreachable from this body.
    if (r.ok) expect(Object.keys(r.body).sort()).toEqual(["focus", "jobId"]);
  });

  it("3. structured endpoint receives job/focus; invalid input settles locally", () => {
    expect(buildVerifyBody("", "x").ok).toBe(false);
    expect(buildVerifyBody("job-1", "   ").ok).toBe(false);
    expect(buildVerifyBody("job-1", "x".repeat(2001)).ok).toBe(false);
  });

  it("4. the body cannot trigger the old direct-diff branch", () => {
    const r = buildVerifyBody("job-1", "guard missing");
    expect(r.ok).toBe(true);
    if (r.ok) expect("diff" in r.body).toBe(false);
  });

  it("5. model empty response becomes a controlled error", () => {
    const msg = toVerifyError(502, { error: "Model request failed", status: 502 });
    expect(msg).toContain("Model request failed");
    expect(msg).toContain("no sandbox run started");
    expect(msg).not.toMatch(/NEBIUS_API_KEY|Bearer /);
  });

  it("6. structured schema failure becomes a controlled error", () => {
    expect(toVerifyError(400, { error: "Invalid edit plan", status: 400 })).toBe("Invalid edit plan");
    expect(toVerifyError(400, { error: "Malformed edit plan", status: 400 })).toBe("Malformed edit plan");
    expect(toVerifyError(500, {})).toBe("Verification request failed.");
  });

  it("7. successful structured result renders verification state", () => {
    const v = toLiveVerification({
      status: "VERIFIED",
      history: [{ state: "PROPOSED" }, { state: "VERIFIED" }],
      apply: { applied: true },
      verification: { command: "pnpm test", exitCode: 0, timedOut: false, passed: true },
      verified: true,
    });
    expect(v).toMatchObject({ status: "VERIFIED", applied: true, command: "pnpm test", exitCode: 0, passed: true });
    expect(v?.history).toEqual(["PROPOSED", "VERIFIED"]);
    expect(toLiveVerification(null)).toBeNull();
    expect(toLiveVerification({})).toBeNull();
    expect(describeRunStatus("EDIT_CONTEXT_MISMATCH")).toBe("Edit context mismatch");
    expect(describeRunStatus("APPLY_FAILED")).toBe("Patch apply failed");
    expect(describeRunStatus("TIMEOUT")).toBe("Verification timed out");
    expect(describeRunStatus("VERIFIED")).toBe("VERIFIED");
  });

  it("8. loading state always settles: builders are synchronous", () => {
    const good = buildVerifyBody("job-1", "x");
    const bad = buildVerifyBody("job-1", "");
    expect(good).not.toBeInstanceOf(Promise);
    expect(bad).not.toBeInstanceOf(Promise);
    expect(bad.ok).toBe(false);
  });
});

describe("current vs history separation (no live model)", () => {
  const historyViews = () => [
    toForgeRunView(diffRun({ id: "run-old", status: "VERIFIED" }), 1)!,
    toForgeRunView(structuredRun({ id: "run-new" }), 2)!,
  ];

  it("1. regenerate request includes the current jobId", () => {
    const r = buildVerifyBody("job-current", "guard missing");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.jobId).toBe("job-current");
  });

  it("2. verify request includes the current jobId", () => {
    const r = buildVerifyBody("job-current", "duplicate keys rejected");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toEqual({ jobId: "job-current", focus: "duplicate keys rejected" });
  });

  it("3. success adopts the run as the current proposal", () => {
    const current = findRunView(historyViews(), "run-new");
    expect(current?.edits).toEqual([{ path: "src/payments.ts", function: "createPayment" }]);
    expect(current?.outcome).toBe("VERIFIED");
  });

  it("4. cleared identity renders NOT RUN, never a stale state", () => {
    expect(findRunView(historyViews(), null)).toBeNull();
  });

  it("5. old VERIFIED run remains in history", () => {
    const views = historyViews();
    expect(views).toHaveLength(2);
    expect(views[0]?.outcome).toBe("VERIFIED");
    expect(views[0]?.id).toBe("run-old");
  });

  it("6. old VERIFIED run is not displayed as current", () => {
    const views = historyViews();
    // No adopted id (fresh regenerate click, failed generation, fresh
    // page): current is null although history holds a VERIFIED run.
    expect(findRunView(views, null)).toBeNull();
    expect(views.some((v) => v.outcome === "VERIFIED")).toBe(true);
  });

  it("7. proposal path comes from the actual current edit", () => {
    const current = findRunView(historyViews(), "run-new");
    const paths = [...new Set((current?.edits ?? []).map((e) => e.path))];
    expect(paths).toEqual(["src/payments.ts"]);
    expect(paths).not.toContain("src/services/transactions.ts");
  });

  it("8. src/payments.ts renders when it is the actual target", () => {
    const html = renderToStaticMarkup(
      ForgeRunPanel({ run: findRunView(historyViews(), "run-new")! })
    );
    expect(html).toContain("src/payments.ts");
    expect(html).not.toContain("transactions.ts");
  });

  it("9. missing active job produces a controlled error", () => {
    expect(buildVerifyBody("", "guard missing")).toEqual({
      ok: false,
      error: "No analysis job selected.",
    });
    expect(buildVerifyBody("  ", "guard missing").ok).toBe(false);
  });

  it("10. errors never mutate historical evidence", () => {
    const before = historyViews();
    const snapshot = JSON.parse(JSON.stringify(before));
    findRunView(before, null);
    toVerifyError(502, { error: "Model request failed" });
    expect(before).toEqual(snapshot);
    expect(before).toHaveLength(2);
  });

  it("11. verify uses the current proposal only, never historical edits", () => {
    const r = buildVerifyBody("job-current", "guard missing");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.body).sort()).toEqual(["focus", "jobId"]);
      expect("runId" in r.body).toBe(false);
      expect("diff" in r.body).toBe(false);
    }
  });

  it("12. selectors settle synchronously", () => {
    const views = historyViews();
    const found = findRunView(views, "run-old");
    expect(found).not.toBeInstanceOf(Promise);
    expect(found?.id).toBe("run-old");
    expect(findRunView(views, "no-such-run")).toBeNull();
    expect(findRunView([], "run-old")).toBeNull();
  });
});

describe("source revision evidence (no live backend)", () => {
  const REF = "hubris/buggy-idempotency";
  const SHA40 = "2".repeat(40);

  function revisionedRun(over: Record<string, unknown> = {}) {
    return structuredRun({
      source: { repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git", ref: REF, refSource: "job", commitSha: SHA40, tarballSha256: "t".repeat(64) },
      sandboxSource: { ref: REF, sha: SHA40, matched: true },
      ...over,
    });
  }

  it("8. run view persists analysis ref", () => {
    const v = toForgeRunView(revisionedRun(), 1)!;
    expect(v.source.ref).toBe(REF);
    expect(v.source.refSource).toBe("job");
    expect(v.source.commitSha).toBe(SHA40);
  });

  it("9. run view persists sandbox ref and match", () => {
    const v = toForgeRunView(revisionedRun(), 1)!;
    expect(v.source.sandboxRef).toBe(REF);
    expect(v.source.sandboxSha).toBe(SHA40);
    expect(v.source.sandboxMatched).toBe(true);
  });

  it("10. panel displays the actual ref and commit", () => {
    const html = renderToStaticMarkup(
      ForgeRunPanel({ run: toForgeRunView(revisionedRun(), 1)! })
    );
    expect(html).toContain(REF);
    expect(html).toContain(`${SHA40.slice(0, 12)}…`);
    expect(html).toContain("Revision match");
  });

  it("11. current verification shares the proposal source revision", () => {
    const v = toForgeRunView(revisionedRun(), 4)!;
    expect(v.outcome).toBe("VERIFIED");
    expect(v.source.ref).toBe(REF);
    expect(v.source.sandboxRef).toBe(REF);
    expect(v.source.sandboxMatched).toBe(true);
    expect(v.verification?.result).toBe("PASS");
  });

  it("12. historical runs retain their own revisions", () => {
    const views = [
      toForgeRunView(revisionedRun({ id: "a" }), 1)!,
      toForgeRunView(
        revisionedRun({ id: "b", source: { ref: "main", refSource: "requested", commitSha: "3".repeat(40) }, sandboxSource: { ref: "main", sha: "3".repeat(40), matched: true } }),
        2
      )!,
    ];
    expect(views[0]?.source.ref).toBe(REF);
    expect(views[1]?.source.ref).toBe("main");
  });

  it("legacy runs without source evidence render fallbacks, never fabrications", () => {
    const v = toForgeRunView(structuredRun(), 1)!;
    expect(v.source.ref).toBeNull();
    expect(v.source.sandboxMatched).toBeNull();
    const html = renderToStaticMarkup(ForgeRunPanel({ run: v }));
    expect(html).toContain("Analysis ref");
    expect(html).not.toContain("hubris/buggy-idempotency");
  });

  it("jobSourceRef reads the analyzed ref, null for legacy jobs", () => {
    expect(jobSourceRef({ result: { ref: REF } })).toBe(REF);
    expect(jobSourceRef({ result: {} })).toBeNull();
    expect(jobSourceRef({ result: null })).toBeNull();
    expect(jobSourceRef(null)).toBeNull();
  });

  it("SOURCE_MISMATCH maps to an explicit outcome and banner", () => {
    const v = toForgeRunView(structuredRun({ status: "SOURCE_MISMATCH" }), 1)!;
    expect(v.outcome).toBe("SOURCE_MISMATCH");
    expect(describeRunStatus("SOURCE_MISMATCH")).toBe("Source revision mismatch");
    const html = renderToStaticMarkup(ForgeRunPanel({ run: v }));
    expect(html).toContain("SOURCE REVISION MISMATCH");
    expect(html).toContain("NOT RUN");
  });

  it("EDIT_CONTEXT_MISMATCH surfaces the bounded byte-mismatch diagnostic", () => {
    const mismatch = {
      oldTextLength: 11,
      sourceLength: 13,
      matchingPrefixChars: 0,
      sourceOffset: -1,
      oldTextSnippet: "missing();",
      sourceSnippet: "foo();\n",
    };
    const v = toForgeRunView(
      structuredRun({ status: "EDIT_CONTEXT_MISMATCH", mismatch }),
      1
    )!;
    expect(v.outcome).toBe("VALIDATION_FAILED");
    expect(v.mismatch?.oldTextLength).toBe(11);
    expect(v.mismatch?.sourceLength).toBe(13);
    expect(v.mismatch?.matchingPrefixChars).toBe(0);
    const html = renderToStaticMarkup(ForgeRunPanel({ run: v }));
    expect(html).toContain("Exact-match failure");
    expect(html).toContain("Model oldText 11 chars");
    expect(html).toContain("authoritative source 13 chars");
    expect(html).toContain("missing();");
    expect(html).toContain("not applied");
  });

  it("malformed mismatch evidence degrades to null, never fabricated", () => {
    const v = toForgeRunView(
      structuredRun({ status: "EDIT_CONTEXT_MISMATCH", mismatch: { nope: true } }),
      1
    )!;
    expect(v.mismatch).toBeNull();
  });
});

describe("INVESTIGATE → FORGE flow (no live calls)", () => {
  it("binds reproduction requests to the exact investigation", () => {
    expect(buildReproduceBody("job-a", "inv-a", "pnpm test -- tests/users.test.ts")).toEqual({
      ok: true,
      body: { jobId: "job-a", investigationId: "inv-a", script: "pnpm test -- tests/users.test.ts" },
    });
  });

  const READY_PAYLOAD = {
    jobId: "job-1",
    investigationId: "inv-1",
    status: "READY",
    plan: {
      summary: '"createPayment" in src/payments.ts matches the report',
      target: { file: "src/payments.ts", function: "createPayment" },
      currentBehavior: "Reported behavior: duplicate keys accepted",
      expectedBehavior: "Duplicate keys are rejected and the suite passes.",
      repairContract: {
        requiredOutcome: "The repeated request must throw.",
        preserveBehavior: ["Preserve the duplicate error assertion."],
        relevantCondition: "Repository condition: if (idempotencyKey !== undefined)",
        relevantOperation: "Repository operation: seenIdempotencyKeys.add(idempotencyKey);",
        existingErrorContract: "Related tests require an error matching: /duplicate/i.",
        minimalRepairDescription: "Restore the missing guard at the existing condition before the existing payment operation.",
        setupFacts: ["const payment = createPayment(...)"],
        actionFacts: ["retryPayment()"],
        observedFacts: ["duplicate payment is created"],
        expectedFacts: ["expect(() => retryPayment()).toThrow()"],
        sourceEvidence: ["if (idempotencyKey !== undefined)", "seenIdempotencyKeys.add(idempotencyKey);"],
        relevantAssertions: ["expect(() => retryPayment()).toThrow()"],
        conditionOperationAreDistinct: true,
      },
      constraints: ["Make the smallest possible change.", 'Keep test "payments.test" passing.'],
      evidence: ["Function createPayment at src/payments.ts:41"],
      confidence: "medium",
    },
  };

  it("parses READY/AMBIGUOUS/NO_MATCH verdicts, rejects malformed payloads", () => {
    const ready = toInvestigation(READY_PAYLOAD);
    expect(ready?.status).toBe("READY");
    expect(ready?.plan?.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(toInvestigation({ jobId: "j", status: "AMBIGUOUS", message: "two targets" })?.message).toBe("two targets");
    expect(toInvestigation({ jobId: "j", status: "NO_MATCH", message: "none" })?.status).toBe("NO_MATCH");
    expect(toInvestigation(null)).toBeNull();
    expect(toInvestigation({ status: "READY" })).toBeNull();
    expect(toInvestigation({ status: "READY", plan: {} })).toBeNull();
    expect(toInvestigation({ status: "BOGUS" })).toBeNull();
    expect(canForgePlan(toInvestigation({ ...READY_PAYLOAD, investigationId: undefined }))).toBe(false);
  });

  it("FORGE FIX enables only for verified READY plans", () => {
    expect(canForgePlan(toInvestigation(READY_PAYLOAD))).toBe(true);
    expect(canForgePlan(toInvestigation({ status: "AMBIGUOUS", message: "x" }))).toBe(false);
    expect(canForgePlan(toInvestigation({ status: "NO_MATCH", message: "x" }))).toBe(false);
    expect(canForgePlan(null)).toBe(false);
  });

  it("restores the latest READY investigation from persisted job state", () => {
    const saved = findSavedInvestigation({
      id: "job-1",
      result: {
        investigationRuns: [
          { ...READY_PAYLOAD, investigationId: "inv-old", jobId: "job-1", focus: "old" },
          { ...READY_PAYLOAD, investigationId: "inv-new", jobId: "job-1", focus: "new" },
        ],
      },
    });
    expect(saved?.investigationId).toBe("inv-new");
    expect(saved?.focus).toBe("new");
    expect(findSavedInvestigation({ result: { investigationRuns: [] } })).toBeNull();
    expect(
      findSavedInvestigation(
        {
          result: {
            investigationRuns: [
              { ...READY_PAYLOAD, investigationId: "inv-old", jobId: "job-1", focus: "old" },
            ],
          },
        },
        "missing"
      )
    ).toBeNull();
  });

  it("findSavedInvestigation loads the exact id, never another investigation", () => {
    const job = {
      id: "job-1",
      result: {
        investigationRuns: [
          { ...READY_PAYLOAD, investigationId: "inv-old", jobId: "job-1", focus: "old" },
          { ...READY_PAYLOAD, investigationId: "inv-new", jobId: "job-1", focus: "new" },
        ],
      },
    };
    // Requesting the OLDER investigation returns it — not the newest.
    expect(findSavedInvestigation(job, "inv-old")?.investigationId).toBe("inv-old");
    expect(findSavedInvestigation(job, "inv-old")?.focus).toBe("old");
    // A non-READY run with the matching id is never promoted.
    expect(
      findSavedInvestigation(
        {
          id: "job-1",
          result: {
            investigationRuns: [
              { ...READY_PAYLOAD, investigationId: "inv-old", jobId: "job-1", focus: "old" },
              { investigationId: "inv-amb", status: "AMBIGUOUS", jobId: "job-1", message: "x" },
            ],
          },
        },
        "inv-amb"
      )
    ).toBeNull();
  });

  it("buildForgeBody requires an investigationId and bounded focus", () => {
    const ok = buildForgeBody("job-1", "inv-1", "Repair focus");
    expect(ok).toEqual({
      ok: true,
      body: { jobId: "job-1", investigationId: "inv-1", focus: "Repair focus" },
    });
    expect(buildForgeBody("job-1", "", "focus").ok).toBe(false);
    expect(buildForgeBody("job-1", null, "focus").ok).toBe(false);
    expect(buildForgeBody("", "inv-1", "focus").ok).toBe(false);
    expect(buildForgeBody("job-1", "inv-1", "   ").ok).toBe(false);
    expect(buildForgeBody("job-1", "inv-1", "x".repeat(2001)).ok).toBe(false);
  });

  it("navigation helpers carry the exact investigation identity", () => {
    expect(forgeReviewHref("job-1", "inv-1")).toBe("/forge?jobId=job-1&investigationId=inv-1");
    expect(investigationReviewHref("job-1", "inv-1")).toBe(
      "/investigate?jobId=job-1&investigationId=inv-1"
    );
  });

  it("builds the Forge handoff from the returned response identities", () => {
    const ready = toInvestigation(READY_PAYLOAD);
    expect(ready).not.toBeNull();
    expect(canForgePlan(ready)).toBe(true);
    expect(forgeReviewHref(ready!.jobId!, ready!.investigationId!)).toBe(
      "/forge?jobId=job-1&investigationId=inv-1"
    );
  });

  it("investigate body requires job and bounded description", () => {
    expect(buildInvestigateBody("job-1", "duplicate keys accepted")).toEqual({
      ok: true,
      body: { jobId: "job-1", focus: "duplicate keys accepted" },
    });
    expect(buildInvestigateBody("", "x").ok).toBe(false);
    expect(buildInvestigateBody("job-1", "   ").ok).toBe(false);
    expect(buildInvestigateBody("job-1", "x".repeat(501)).ok).toBe(false);
  });

  it("composed Forge focus carries the complete repair contract", () => {
    const view = toInvestigation(READY_PAYLOAD);
    expect(view?.plan).not.toBeNull();
    const focus = composeForgeFocus(view!.plan!);
    expect(focus.length).toBeGreaterThan(0);
    expect(focus.length).toBeLessThanOrEqual(2000);
    expect(focus).toContain("createPayment");
    expect(focus).toContain("src/payments.ts");
    expect(focus).toContain("smallest possible change");
  });

  it("reports status, URL, and bounded response details for malformed responses", () => {
    const message = describeInvestigationFailure(200, "/api/investigate", { answer: "legacy" });
    expect(message).toContain("HTTP 200");
    expect(message).toContain("/api/investigate");
    expect(message).toContain('"answer":"legacy"');
    expect(describeInvestigationFailure(null, "/api/investigate", undefined)).toContain(
      "network error"
    );
  });
});

// Phase RAG frontend contract: the state model, clarification, and the
// clarification-carrying investigate body are additive and never fabricate.
describe("investigation agent view-model (RAG)", () => {
  it("parses state, observed/expected behavior, and clarification", () => {
    const view = toInvestigation({
      status: "AMBIGUOUS",
      investigationId: "inv-2",
      jobId: "job-1",
      state: "CLARIFICATION_NEEDED",
      observedBehavior: "SAVE10 leaves the total unchanged",
      expectedBehavior: "SAVE10 reduces the total by 10%",
      clarification: {
        question: "Is the problem the order total?",
        options: ["the order total", "order creation"],
      },
    });
    expect(view?.state).toBe("CLARIFICATION_NEEDED");
    expect(view?.observedBehavior).toContain("SAVE10");
    expect(view?.clarification?.options).toHaveLength(2);
  });

  it("drops a malformed clarification and an unknown state", () => {
    const view = toInvestigation({
      status: "NO_MATCH",
      investigationId: "inv-3",
      jobId: "job-1",
      state: "NONSENSE",
      clarification: { question: "", options: [] },
    });
    expect(view?.state).toBeNull();
    expect(view?.clarification).toBeNull();
  });

  it("carries the clarification question and answer into the investigate body", () => {
    const prepared = buildInvestigateBody("job-1", "Something is wrong with orders.", {
      priorQuestion: "Is the problem the order total?",
      answer: "Yes, the total.",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.body.priorQuestion).toBe("Is the problem the order total?");
    expect(prepared.body.clarification).toBe("Yes, the total.");
  });

  it("parses structured clarification options with stable ids (legacy strings keep working)", () => {
    const view = toInvestigation({
      status: "AMBIGUOUS",
      investigationId: "inv-4",
      jobId: "job-1",
      state: "CLARIFICATION_NEEDED",
      clarification: {
        questionId: "q_abc",
        question: "Which test matches?",
        options: [
          { id: "opt_1", label: "\"rejects unknown users\" (tests/payments.test.ts)" },
          { id: "", label: "dropped: no id" },
          "legacy label",
        ],
      },
    });
    expect(view?.clarification?.questionId).toBe("q_abc");
    expect(view?.clarification?.options).toEqual([
      { id: "opt_1", label: "\"rejects unknown users\" (tests/payments.test.ts)" },
      { id: "legacy label", label: "legacy label" },
    ]);
  });

  it("parses a blocked state with a specific next step, and drops a partial one", () => {
    const blocked = toInvestigation({
      status: "AMBIGUOUS",
      investigationId: "inv-5",
      jobId: "job-1",
      state: "AMBIGUOUS",
      blocked: { code: "NO_TEST_SCENARIO", reason: "No test exercises f.", nextStep: "Name the test." },
    });
    expect(blocked?.blocked).toEqual({ code: "NO_TEST_SCENARIO", reason: "No test exercises f.", nextStep: "Name the test." });
    const partial = toInvestigation({ status: "AMBIGUOUS", investigationId: "inv-6", jobId: "job-1", blocked: { code: "X" } });
    expect(partial?.blocked).toBeNull();
  });

  it("builds a structured answer body from stable ids (no free text)", () => {
    const prepared = buildInvestigateBody("job-1", "Users cannot be found sometimes.", {
      priorInvestigationId: "inv-2",
      questionId: "q_abc",
      optionId: "opt_1",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.body.priorInvestigationId).toBe("inv-2");
    expect(prepared.body.answer).toEqual({ questionId: "q_abc", optionId: "opt_1" });
    expect("clarification" in prepared.body).toBe(false);
  });

  it("refuses to build a structured answer that lost its question identity", () => {
    const prepared = buildInvestigateBody("job-1", "x", { priorInvestigationId: "", questionId: "q", optionId: "o" });
    expect(prepared.ok).toBe(false);
  });

  it("omits clarification fields for a fresh report", () => {
    const prepared = buildInvestigateBody("job-1", "duplicate keys accepted");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect("clarification" in prepared.body).toBe(false);
  });
});

// ---- User-facing verification assessment ----
//
// A non-zero suite exit must not become a generic FAILED when the repair was
// applied and the investigated behavior passed.
describe("verification assessment (ForgeRunView + ForgeRunPanel)", () => {
  function runWith(
    assessment: Record<string, unknown> | null,
    opts: { status?: string; exitCode?: number; timedOut?: boolean; stdout?: string } = {}
  ) {
    const status = opts.status ?? "FAILED";
    const exitCode = opts.exitCode ?? (status === "VERIFIED" ? 0 : 1);
    const raw = structuredRun({
      status,
      verified: status === "VERIFIED",
      ...(opts.stdout !== undefined ? { stdout: opts.stdout } : {}),
      verification: {
        command: "pnpm test",
        commandSource: "detected",
        exitCode,
        timedOut: opts.timedOut ?? false,
        passed: status === "VERIFIED",
        ...(assessment ? { assessment } : {}),
      },
    });
    return resolveForgeRuns({ result: { forgeRuns: [raw] } })[0];
  }

  it("REPAIR_VERIFIED: applied + target passed + unrelated failures", () => {
    const view = runWith({
      state: "REPAIR_VERIFIED",
      patchApplied: true,
      targetVerificationPassed: true,
      targetTestFile: "tests/orders.test.ts",
      targetScenario: "applies a discount code to the order total",
      targetCommand:
        "pnpm exec vitest run 'tests/orders.test.ts' -t 'applies a discount code to the order total'",
      fullSuitePassed: false,
      unrelatedTestFailures: 3,
      failedTests: ["tests/cart.test.ts", "tests/sessions.test.ts", "tests/users.test.ts"],
      targetFailure: null,
    });
    expect(view.outcome).toBe("REPAIR_VERIFIED");
    expect(shortRunStatus(view)).toBe("REPAIR VERIFIED");
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    // Primary outcome, consistent in the header and banner.
    expect(html).toContain("REPAIR VERIFIED");
    expect(html).toContain("structured edit · REPAIR VERIFIED");
    expect(html).toContain("Target behavior verified");
    // The exact investigated scenario is named (not inferred from the suite).
    expect(html).toContain("Target verification");
    expect(html).toContain("applies a discount code to the order total");
    expect(html).toContain("tests/orders.test.ts");
    expect(html).toContain("Regression suite");
    expect(html).toContain("✗ FAILED · 3 unrelated tests failed");
    expect(html).toContain("Command: pnpm test");
    expect(html).toContain("Exit code: 1");
    // Secondary details, full-suite failure subordinate but visible.
    expect(html).toContain("Unrelated failures");
    expect(html).toContain("The broader test suite still has failures outside the investigated behavior.");
    expect(html).toContain("tests/cart.test.ts");
    expect(html).toContain("tests/users.test.ts");
    expect(html).toContain("Verification evidence (test output)");
    // No competing generic lifecycle failure label, and no unproven claim.
    expect(html).not.toContain("VERIFICATION FAILED");
    expect(html).not.toContain("structured edit · FAILED");
    expect(html).not.toContain("pre-existing");
    // The final lifecycle step is neutral, not an empty "Verified".
    expect(html).toContain("Verification assessed");
  });

  it("REPAIR_NOT_VERIFIED: the reported behavior still fails", () => {
    const view = runWith({
      state: "REPAIR_NOT_VERIFIED",
      patchApplied: true,
      targetVerificationPassed: false,
      fullSuitePassed: false,
      unrelatedTestFailures: 1,
      failedTests: ["tests/orders.test.ts", "tests/cart.test.ts"],
      targetTestFile: "tests/orders.test.ts",
      targetFailure: "tests/orders.test.ts",
    });
    expect(view.outcome).toBe("REPAIR_NOT_VERIFIED");
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).toContain("REPAIR NOT VERIFIED");
    expect(html).toContain("The investigated behavior is still failing.");
    expect(html).toContain("tests/orders.test.ts");
  });

  it("FULL_SUITE_PASSED: everything passed", () => {
    const view = runWith(
      {
        state: "FULL_SUITE_PASSED",
        patchApplied: true,
        targetVerificationPassed: true,
        fullSuitePassed: true,
        unrelatedTestFailures: 0,
        failedTests: [],
        targetTestFile: "tests/orders.test.ts",
        targetFailure: null,
      },
      { status: "VERIFIED", exitCode: 0 }
    );
    expect(view.outcome).toBe("FULL_SUITE_PASSED");
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).toContain("FULL SUITE PASSED");
    expect(html).toContain("all tests passed");
  });

  it("VERIFICATION_INCOMPLETE: cannot attribute the failures", () => {
    const view = runWith({
      state: "VERIFICATION_INCOMPLETE",
      patchApplied: true,
      targetVerificationPassed: null,
      fullSuitePassed: false,
      unrelatedTestFailures: 0,
      failedTests: [],
      targetTestFile: null,
      targetFailure: null,
    });
    expect(view.outcome).toBe("VERIFICATION_INCOMPLETE");
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).toContain("VERIFICATION INCOMPLETE");
    expect(html).toContain("could not determine whether the test failures affect the reported bug");
  });

  it("VERIFICATION_INCOMPLETE with a named target says it could not directly verify it", () => {
    const view = runWith({
      state: "VERIFICATION_INCOMPLETE",
      patchApplied: true,
      targetVerificationPassed: null,
      targetTestFile: "tests/orders.test.ts",
      targetScenario: "applies a discount code to the order total",
      targetCommand:
        "pnpm exec vitest run 'tests/orders.test.ts' -t 'applies a discount code to the order total'",
      fullSuitePassed: false,
      unrelatedTestFailures: 0,
      failedTests: [],
      targetFailure: null,
    });
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).toContain("VERIFICATION INCOMPLETE");
    expect(html).toContain("could not directly verify the investigated test scenario");
  });

  it("legacy entries without an assessment keep the lifecycle outcome", () => {
    const failed = runWith(null);
    expect(failed.outcome).toBe("VERIFICATION_FAILED");
    const verified = runWith(null, { status: "VERIFIED", exitCode: 0 });
    expect(verified.outcome).toBe("VERIFIED");
    expect(verified.verification?.assessment).toBeNull();
  });
});

// UX wording: the full test command is the "Regression suite", distinct from
// the exact "Target verification". The panel must not label it as generic
// "Verification" nor render a contradictory "Verification for run … FAIL".
describe("verification wording (target vs regression)", () => {
  const view = resolveForgeRuns({
    result: {
      forgeRuns: [
        structuredRun({
          status: "FAILED",
          verified: false,
          verification: {
            command: "pnpm test",
            commandSource: "detected",
            exitCode: 1,
            timedOut: false,
            passed: false,
            assessment: {
              state: "REPAIR_VERIFIED",
              patchApplied: true,
              targetVerificationPassed: true,
              targetTestFile: "tests/orders.test.ts",
              targetScenario: "applies a discount code to the order total",
              targetCommand:
                "pnpm exec vitest run 'tests/orders.test.ts' -t 'applies a discount code to the order total'",
              fullSuitePassed: false,
              unrelatedTestFailures: 3,
              failedTests: ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"],
              targetFailure: null,
            },
          },
        }),
      ],
    },
  })[0];

  it("renders Target verification and Regression suite as distinct blocks", () => {
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).toContain("Target verification");
    expect(html).toContain("applies a discount code to the order total");
    expect(html).toContain("tests/orders.test.ts");
    expect(html).toContain("Regression suite");
    expect(html).toContain("✗ FAILED · 3 unrelated tests failed");
    expect(html).toContain("Command: pnpm test");
    expect(html).toContain("Exit code: 1");
  });

  it("never labels the full command as generic Verification", () => {
    const html = renderToStaticMarkup(ForgeRunPanel({ run: view }));
    expect(html).not.toContain("Verification Command");
    expect(html).not.toContain("Verification for run");
    // One primary outcome label; the regression failure is subordinate.
    expect(html).toContain("REPAIR VERIFIED");
    expect(html).not.toContain("VERIFICATION FAILED");
  });
});

// ---- SHIP eligibility / body / preview ----
describe("SHIP (eligibility, body, preview)", () => {
  function runWith(assessment: Record<string, unknown> | null, applyApplied = true) {
    return resolveForgeRuns({
      result: {
        forgeRuns: [
          structuredRun({
            apply: { applied: applyApplied },
            verification: {
              command: "pnpm test",
              commandSource: "detected",
              exitCode: 1,
              timedOut: false,
              passed: false,
              ...(assessment ? { assessment } : {}),
            },
          }),
        ],
      },
    })[0];
  }

  it("is eligible only for REPAIR_VERIFIED / FULL_SUITE_PASSED", () => {
    expect(shipEligible(runWith({ state: "REPAIR_VERIFIED", targetVerificationPassed: true, fullSuitePassed: false })).eligible).toBe(true);
    expect(shipEligible(runWith({ state: "FULL_SUITE_PASSED", targetVerificationPassed: true, fullSuitePassed: true })).eligible).toBe(true);
    expect(shipEligible(runWith({ state: "REPAIR_NOT_VERIFIED", targetVerificationPassed: false })).eligible).toBe(false);
    expect(shipEligible(runWith({ state: "VERIFICATION_INCOMPLETE", targetVerificationPassed: null })).eligible).toBe(false);
    expect(shipEligible(runWith({ state: "REPAIR_VERIFIED", targetVerificationPassed: true }, false)).eligible).toBe(false);
    expect(shipEligible(runWith(null)).eligible).toBe(false);
  });

  it("REPAIR_VERIFIED requires a confirmed target pass (null/missing/false block)", () => {
    const missing = shipEligible(runWith({ state: "REPAIR_VERIFIED", fullSuitePassed: false }));
    expect(missing.eligible).toBe(false);
    expect(missing.reason).toContain("Target verification must pass");
    expect(shipEligible(runWith({ state: "REPAIR_VERIFIED", targetVerificationPassed: null })).eligible).toBe(false);
    expect(shipEligible(runWith({ state: "REPAIR_VERIFIED", targetVerificationPassed: false })).eligible).toBe(false);
  });

  it("FULL_SUITE_PASSED without a targeted run stays eligible (suite proves it)", () => {
    expect(
      shipEligible(runWith({ state: "FULL_SUITE_PASSED", targetVerificationPassed: null, fullSuitePassed: true })).eligible
    ).toBe(true);
    expect(
      shipEligible(runWith({ state: "FULL_SUITE_PASSED", targetVerificationPassed: false, fullSuitePassed: true })).eligible
    ).toBe(false);
  });

  it("never renders a missing target result as a pass", () => {
    expect(targetVerificationMark(true)).toBe("✓");
    expect(targetVerificationMark(false)).toBe("✗");
    expect(targetVerificationMark(null)).toBe("—");
    expect(targetVerificationMark(undefined)).toBe("—");
  });

  it("requires both ids for the ship request body", () => {
    expect(buildShipBody("job-1", "run-1")).toEqual({ ok: true, body: { jobId: "job-1", forgeRunId: "run-1" } });
    expect(buildShipBody("", "run-1").ok).toBe(false);
    expect(buildShipBody("job-1", null).ok).toBe(false);
  });

  it("parses a persisted pull request and previews a safe branch/title", () => {
    const withPr = resolveForgeRuns({
      result: {
        forgeRuns: [
          structuredRun({
            pullRequest: {
              provider: "github",
              repository: "o/r",
              branch: "hubris/fix/x",
              baseBranch: "main",
              commitSha: "a".repeat(40),
              prNumber: 7,
              prUrl: "https://github.com/o/r/pull/7",
              status: "OPEN",
            },
          }),
        ],
      },
    })[0];
    expect(withPr.pullRequest?.prNumber).toBe(7);
    expect(withPr.pullRequest?.prUrl).toContain("/pull/7");
    expect(SHIP_PATH).toBe("/api/ship");

    const branch = shipBranchPreview("createOrder", "discount is wrong", "ab12cd34");
    expect(branch.startsWith("hubris/fix/create-order-discount-is-wrong-")).toBe(true);
    expect(shipBranchPreview("x$(rm) y", "a;b #c", null)).not.toMatch(/[ $;#`]/);
    expect(shipTitlePreview("createOrder", "discount is wrong")).toBe("Fix createOrder: discount is wrong");
  });
});

describe("shipRepairHref", () => {
  it("is deterministic, URL-safe, and carries jobId + forgeRunId", () => {
    expect(shipRepairHref("job-1", "run-2")).toBe("/ship?jobId=job-1&forgeRunId=run-2");
    expect(shipRepairHref("job/ with space", "run#2")).toBe(
      "/ship?jobId=job%2F+with+space&forgeRunId=run%232"
    );
  });

  it("never emits a bare /ship link when ids are present", () => {
    expect(shipRepairHref("job-1", "run-2")).not.toBe("/ship");
  });
});
