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
  describeRunStatus,
  toLiveVerification,
  toVerifyError,
  STRUCTURED_VERIFY_PATH,
  LEGACY_VERIFY_PATH,
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
    expect(buildVerifyBody("job-1", "x".repeat(501)).ok).toBe(false);
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
