import { describe, expect, it } from "vitest";
import { suggestReproduction, detectTestRunner } from "../app/lib/reproduction";
import type { LiveJob } from "../app/lib/live-twin";
import type { ReadyInvestigationView } from "../app/lib/forge-run";

const investigation = {
  investigationId: "inv-1",
  jobId: "job-1",
  focus: "expired token is accepted",
  createdAt: null,
  status: "READY",
  message: null,
  plan: {
    summary: "target",
    target: { file: "src/users.ts", function: "resetPassword" },
    currentBehavior: "accepted",
    expectedBehavior: "rejected",
    repairContract: {
      requiredOutcome: "reject",
      preserveBehavior: [],
      relevantCondition: "expiry",
      relevantOperation: "accept",
      existingErrorContract: "",
      minimalRepairDescription: "guard",
      setupFacts: [],
      actionFacts: [],
      observedFacts: [],
      expectedFacts: [],
      sourceEvidence: [],
      relevantAssertions: [],
      conditionOperationAreDistinct: true,
    },
    constraints: [],
    evidence: ["Relevant test scenario \"rejects an expired token\" in tests/users.test.ts"],
    reproduction: { scenario: "rejects an expired token", testFile: "tests/users.test.ts" },
    confidence: "high",
  },
} satisfies ReadyInvestigationView;

function job(overrides: Partial<LiveJob["result"]> = {}): LiveJob {
  return {
    id: "job-1",
    repoUrl: "https://github.com/example/users.git",
    status: "complete",
    error: null,
    result: {
      jobId: "job-1",
      repository: { id: "r", name: "example/users", analysisStatus: "complete" },
      stats: { packages: 1, functions: 1, classes: 0, endpoints: 0, tests: 1, relationships: 0, analysisMs: 1 },
      sample: { functions: [], endpoints: [] },
      full: { functions: [], classes: [], endpoints: [], tests: [{ name: "users", path: "tests/users.test.ts", file: "tests/users.test.ts" }], relationships: [] },
      ...overrides,
    },
  };
}

describe("suggestReproduction", () => {
  it("derives a runner-aware command from package metadata and the saved test file", () => {
    const result = suggestReproduction(job({ packageManager: "pnpm", scripts: { test: "vitest run" } }), investigation);
    expect(result).toEqual({
      command: "pnpm exec vitest run tests/users.test.ts --reporter=verbose",
      reason: 'Matches the relevant scenario "rejects an expired token" in tests/users.test.ts.',
    });
  });

  it("uses npx for npm and the jest runner when the repo uses jest", () => {
    expect(
      suggestReproduction(job({ packageManager: "npm", scripts: { test: "vitest run" } }), investigation)?.command
    ).toBe("npx vitest run tests/users.test.ts --reporter=verbose");
    expect(
      suggestReproduction(job({ packageManager: "pnpm", scripts: { test: "jest" } }), investigation)?.command
    ).toBe("pnpm exec jest tests/users.test.ts");
  });

  it("fails closed when repository evidence cannot support a command", () => {
    expect(suggestReproduction(job({ packageManager: "pnpm", scripts: { test: "custom-runner" } }), investigation)).toBeNull();
  });

  it("fails closed without a package manager, test script, or recorded test file", () => {
    expect(suggestReproduction(job({ scripts: { test: "vitest run" } }), investigation)).toBeNull();
    expect(suggestReproduction(job({ packageManager: "pnpm" }), investigation)).toBeNull();
    expect(suggestReproduction(job({ packageManager: "pnpm", scripts: { test: "vitest run" }, full: { functions: [], classes: [], endpoints: [], tests: [], relationships: [] } }), investigation)).toBeNull();
  });
});

describe("detectTestRunner", () => {
  it("recognizes only runners that accept a targeted test file", () => {
    expect(detectTestRunner("vitest run")).toBe("vitest");
    expect(detectTestRunner("jest --coverage")).toBe("jest");
    expect(detectTestRunner("mocha")).toBe("mocha");
    expect(detectTestRunner("custom-runner")).toBeNull();
    expect(detectTestRunner("")).toBeNull();
  });
});
