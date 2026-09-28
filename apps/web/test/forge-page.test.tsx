import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toInvestigation, resolveForgeRuns, findRunForInvestigation, type InvestigationView } from "../app/lib/forge-run";
import InvestigationSummary from "../app/components/InvestigationSummary";
import ForgeNoInvestigation from "../app/components/ForgeNoInvestigation";
import type { JobRepositoryContext } from "../app/lib/workspace";

const REPO: JobRepositoryContext = {
  jobId: "job-1",
  repoName: "acme/api",
  owner: "acme",
  repo: "api",
  ref: "main",
  commitSha: "a".repeat(40),
  repositoryUrl: "https://github.com/acme/api.git",
  status: "complete",
  analysisStatus: "complete",
  hasContext: true,
  label: "acme/api",
};

const READY_PAYLOAD = {
  status: "READY",
  investigationId: "inv-1",
  jobId: "job-1",
  focus: "duplicate keys accepted",
  createdAt: "2026-09-26T00:00:00.000Z",
  plan: {
    summary: "targets createPayment",
    target: { file: "src/payments.ts", function: "createPayment" },
    currentBehavior: "duplicate keys accepted",
    expectedBehavior: "duplicate keys must be rejected",
    repairContract: {
      requiredOutcome: "The repeated request must throw",
      preserveBehavior: ["Keep tests passing"],
      relevantCondition: "if (idempotencyKey !== undefined)",
      relevantOperation: "seenIdempotencyKeys.add(idempotencyKey)",
      existingErrorContract: "/duplicate/",
      minimalRepairDescription: "restore the missing guard",
    },
    constraints: ["smallest change"],
    evidence: ["Test scenario 'rejects duplicates'", "Error contract found"],
    confidence: "high" as const,
  },
};

describe("InvestigationSummary", () => {
  it("renders the persisted investigation state (status, target, expected, evidence, contract, revision)", () => {
    const view = toInvestigation(READY_PAYLOAD) as InvestigationView;
    const html = renderToStaticMarkup(<InvestigationSummary investigation={view} repo={REPO} />);
    expect(html).toContain("READY");
    expect(html).toContain("createPayment() · src/payments.ts");
    expect(html).toContain("duplicate keys must be rejected");
    expect(html).toContain("Test scenario");
    expect(html).toContain("rejects duplicates");
    expect(html).toContain("seenIdempotencyKeys.add(idempotencyKey)");
    expect(html).toContain("main");
    expect(html).toContain("a".repeat(40).slice(0, 12));
  });

  it("renders status + message when the investigation has no plan", () => {
    const view: InvestigationView = {
      investigationId: "inv-amb",
      jobId: "job-1",
      focus: "x",
      createdAt: null,
      status: "AMBIGUOUS",
      plan: null,
      message: "The description is too broad",
    };
    const html = renderToStaticMarkup(<InvestigationSummary investigation={view} repo={REPO} />);
    expect(html).toContain("AMBIGUOUS");
    expect(html).toContain("The description is too broad");
  });
});

describe("ForgeNoInvestigation", () => {
  it("shows the no-investigation notice and GO TO INVESTIGATE", () => {
    const html = renderToStaticMarkup(<ForgeNoInvestigation />);
    expect(html).toContain("No investigation is attached to this Forge run.");
    expect(html).toContain("GO TO INVESTIGATE");
    expect(html).toContain('href="/investigate"');
  });
});

// Guard against the UX regression this task removed: the Forge page must not
// contain an investigation prompt, editor, or auto-investigate action.
describe("Forge page owns forging, not investigation", () => {
  const PAGE = fileURLToPath(
    new URL("../app/(workspace)/forge/page.tsx", import.meta.url)
  );
  const source = readFileSync(PAGE, "utf8");

  it("does not import the investigation prompt editor", () => {
    expect(source).not.toContain("PromptEditor");
    expect(source).not.toContain("INVESTIGATE_PATH");
    expect(source).not.toContain("/api/investigate");
  });

  it("does not render an INVESTIGATE primary action or re-run investigation", () => {
    expect(source).not.toContain("INVESTIGATE ↗");
    expect(source).not.toContain("void investigate()");
    expect(source).not.toContain("buildInvestigateBody");
  });

  it("forges with an explicit investigationId", () => {
    expect(source).toContain("buildForgeBody");
    expect(source).toContain("investigationId");
  });

  it("directs to the Investigation page when nothing is attached", () => {
    expect(source).toContain("ForgeNoInvestigation");
    expect(source).toContain("!investigationId");
    expect(source).toContain("Loading investigation");
  });
});

// Phase 1 guard: a READY investigation must never auto-invoke Forge. Only an
// explicit button click may POST to /api/forge-structured, and refreshing the
// page must not start a run.
describe("Forge never auto-starts a run", () => {
  const PAGE = fileURLToPath(
    new URL("../app/(workspace)/forge/page.tsx", import.meta.url)
  );
  const source = readFileSync(PAGE, "utf8");

  it("binds the only forgeFix call to the explicit button", () => {
    const calls = source.match(/void forgeFix\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source).toContain("onClick={() => void forgeFix()}");
  });

  it("says a patch is not generated yet and never claims a proposal on load", () => {
    expect(source).toContain("Patch not generated yet");
    expect(source).not.toContain("No proposal yet");
    expect(source).toContain("Nothing is forged automatically");
  });

  it("displays an existing run bound to the investigation instead of launching", () => {
    expect(source).toContain("findRunForInvestigation");
  });
});

describe("findRunForInvestigation", () => {
  function runsOf(raw: unknown[]) {
    return resolveForgeRuns({ result: { forgeRuns: raw } });
  }

  it("returns the run bound to the exact investigation id", () => {
    const runs = runsOf([
      { id: "r1", investigationId: "inv-a", status: "VERIFIED" },
      { id: "r2", investigationId: "inv-b", status: "PROPOSED" },
    ]);
    expect(findRunForInvestigation(runs, "inv-b")?.id).toBe("r2");
  });

  it("never matches on jobId, position, or a missing id", () => {
    const runs = runsOf([{ id: "r1", investigationId: "inv-a", status: "PROPOSED" }]);
    expect(findRunForInvestigation(runs, "inv-missing")).toBeNull();
    expect(findRunForInvestigation(runs, null)).toBeNull();
    expect(findRunForInvestigation(runs, "")).toBeNull();
    expect(findRunForInvestigation([], "inv-a")).toBeNull();
  });

  it("ignores runs with no investigation binding", () => {
    const runs = runsOf([{ id: "r1", status: "PROPOSED" }]);
    expect(findRunForInvestigation(runs, "inv-a")).toBeNull();
  });
});

describe("Investigate page owns the exact Forge handoff", () => {
  const PAGE = fileURLToPath(
    new URL("../app/(workspace)/investigate/page.tsx", import.meta.url)
  );
  const source = readFileSync(PAGE, "utf8");

  it("uses the returned response identities and has no bare Forge fallback", () => {
    expect(source).toContain("toInvestigation(data)");
    expect(source).toContain("forgeReviewHref(result.jobId, result.investigationId)");
    expect(source).toContain("canReviewInvestigation(result)");
    expect(source).not.toContain(' : "/forge"');
  });

  it("clears an old investigation identity before a new submission", () => {
    expect(source).toContain('searchParams.delete("investigationId")');
    expect(source).toContain('searchParams.set("investigationId", parsed.investigationId)');
  });
});

// The Forge page must not present the full-suite result as a generic
// "Verification" that contradicts the primary repair outcome.
describe("Forge page regression-suite wording", () => {
  const PAGE = fileURLToPath(
    new URL("../app/(workspace)/forge/page.tsx", import.meta.url)
  );
  const source = readFileSync(PAGE, "utf8");

  it("labels the full test command result as the regression suite", () => {
    expect(source).not.toContain("Verification for run");
    expect(source).toContain("Regression suite:");
    expect(source).not.toContain("Verification Command");
  });
});
