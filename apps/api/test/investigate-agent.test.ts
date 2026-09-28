// Investigation agent orchestration tests. The retrieval layer runs on the
// REAL commerce-service fixture; the model is a deterministic fake so the
// evidence-validation behavior is what is under test.
import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import { buildSourceFacts, toRepoRelative } from "../src/app";
import { buildRetrievalIndex } from "../src/retrieval";

// Mock chatComplete only; keep the real prompt builders and parsers so the
// agent's JSON contract is exercised end to end.
vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return { ...actual, chatComplete: vi.fn() };
});

import { chatComplete, type LlmConfig } from "@hubris/llm";
import { runInvestigationAgent, type RunInvestigationAgentInput } from "../src/investigate-agent";
import type { RetrievalIndex } from "../src/retrieval";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/commerce-service", import.meta.url));

const LLM: LlmConfig = { baseUrl: "http://fake", apiKey: "k", model: "fake-nemotron" };

let TWIN: {
  functions: NonNullable<RunInvestigationAgentInput["functions"]>;
  tests: NonNullable<RunInvestigationAgentInput["tests"]>;
  relationships: NonNullable<RunInvestigationAgentInput["relationships"]>;
  sourceFacts: NonNullable<RunInvestigationAgentInput["sourceFacts"]>;
};
let INDEX: RetrievalIndex;
let discountScenarioId = "";

beforeAll(async () => {
  const twin = await analyzeRepository(FIXTURE);
  const sourceFacts = buildSourceFacts(FIXTURE, twin);
  for (const fn of twin.functions) fn.path = toRepoRelative(FIXTURE, fn.path);
  for (const c of twin.classes) c.path = toRepoRelative(FIXTURE, c.path);
  for (const e of twin.endpoints) e.file = toRepoRelative(FIXTURE, e.file);
  for (const t of twin.tests) {
    t.path = toRepoRelative(FIXTURE, t.path);
    t.file = toRepoRelative(FIXTURE, t.file);
  }
  for (const r of twin.relationships) r.from = toRepoRelative(FIXTURE, r.from);
  TWIN = {
    functions: twin.functions,
    tests: twin.tests,
    relationships: twin.relationships,
    sourceFacts,
  };
  INDEX = buildRetrievalIndex({
    jobId: "job-1",
    repository: "acme/commerce",
    ref: "main",
    commitSha: "a".repeat(40),
    functions: twin.functions,
    tests: twin.tests,
    relationships: twin.relationships,
    sourceFacts,
    scripts: { test: "vitest run" },
    packageManager: "pnpm",
  });
  discountScenarioId =
    INDEX.units.find((u) => u.sourceType === "test" && u.testScenario?.includes("discount"))?.id ?? "";
});

beforeEach(() => {
  vi.mocked(chatComplete).mockReset();
});

const baseInput = (over: Partial<RunInvestigationAgentInput> = {}): RunInvestigationAgentInput => ({
  llm: null,
  jobId: "job-1",
  repository: "acme/commerce",
  ref: "main",
  commitSha: "a".repeat(40),
  scripts: { test: "vitest run" },
  packageManager: "pnpm",
  report: "Something is wrong with the discount.",
  functions: TWIN.functions,
  tests: TWIN.tests,
  relationships: TWIN.relationships,
  sourceFacts: TWIN.sourceFacts,
  ...over,
});

describe("runInvestigationAgent without a model", () => {
  it("degrades to the deterministic verdict and carries provenance", async () => {
    const result = await runInvestigationAgent(
      baseInput({ report: "Refunding a payment twice should throw a cannot be refunded error." })
    );
    expect(result.modelUsed).toBe(false);
    expect(result.deterministic.status).toBe("READY");
    expect(result.state).toBe("READY_FOR_REVIEW");
    expect(result.provenance).toEqual({
      jobId: "job-1",
      repository: "acme/commerce",
      ref: "main",
      commitSha: "a".repeat(40),
    });
  });

  it("retrieves evidence but never invents it", async () => {
    const result = await runInvestigationAgent(baseInput());
    expect(result.retrievedEvidence.length).toBeGreaterThan(0);
    for (const ev of result.retrievedEvidence) {
      expect(ev.provenance.jobId).toBe("job-1");
      expect(ev.provenance.commitSha).toBe("a".repeat(40));
      expect(typeof ev.file).toBe("string");
    }
  });

  it("grounds a vague report on the selected evidence rather than re-investigating", async () => {
    const result = await runInvestigationAgent(
      baseInput({ report: "Something is wrong with orders." })
    );
    // The authoritative selection decides the target; the deterministic layer
    // only validates it. For this repository the order path is selected.
    expect(result.deterministic.status).toBe("READY");
    expect(result.state).toBe("READY_FOR_REVIEW");
    if (result.deterministic.status === "READY") {
      expect(result.deterministic.plan.target.function.toLowerCase()).toContain("order");
    }
    expect(result.relevantScenarios.length).toBeGreaterThan(0);
  });

  it("returns NO_MATCH for an unsupported report", async () => {
    const result = await runInvestigationAgent(baseInput({ report: "The hologram projector is misconfigured." }));
    expect(result.deterministic.status).toBe("NO_MATCH");
    expect(result.state).toBe("NO_MATCH");
  });
});

describe("runInvestigationAgent with a model", () => {
  function fakeModel(unitIds: string[], target: string | null) {
    vi.mocked(chatComplete).mockImplementation(async (_cfg, messages) => {
      const user = messages.map((m) => m.content).join("\n");
      if (user.includes("Decompose the report")) {
        return JSON.stringify({
          observedBehavior: "SAVE10 leaves the total unchanged",
          expectedBehavior: "SAVE10 reduces the total by 10%",
          entities: ["order", "discount"],
          actions: ["createOrder"],
          ambiguities: [],
          queries: ["discount order total", "SAVE10"],
        });
      }
      return JSON.stringify({
        selectedEvidence: unitIds,
        candidateTarget: target,
        hypothesis: "The discount branch leaves the total at the full subtotal.",
        sufficient: true,
        clarificationQuestion: null,
        clarificationOptions: [],
      });
    });
  }

  it("uses the model's retrieved-query expansion and cited evidence", async () => {
    fakeModel([discountScenarioId], "createOrder");
    const result = await runInvestigationAgent(baseInput({ llm: LLM }));
    expect(result.modelUsed).toBe(true);
    expect(result.selectedEvidenceIds).toContain(discountScenarioId);
    expect(result.modelSummary).toContain("discount");
    expect(chatComplete).toHaveBeenCalledTimes(2);
  });

  it("drops fabricated evidence ids and never lets the model decide READY", async () => {
    fakeModel(["fabricated:source:does-not-exist", discountScenarioId], "createOrder");
    const result = await runInvestigationAgent(baseInput({ llm: LLM }));
    expect(result.selectedEvidenceIds).not.toContain("fabricated:source:does-not-exist");
    expect(result.selectedEvidenceIds).toContain(discountScenarioId);
    // Verdict still comes from the deterministic validator over the selected
    // evidence, never from the model's confidence.
    expect(result.deterministic.status).toBe("READY");
    expect(result.state).toBe("READY_FOR_REVIEW");
  });

  it("fails safely when the selected evidence cannot be resolved (no silent fallback)", async () => {
    vi.mocked(chatComplete).mockImplementation(async (_cfg, messages) => {
      const user = messages.map((m) => m.content).join("\n");
      if (user.includes("Decompose the report")) {
        return JSON.stringify({ observedBehavior: "x", expectedBehavior: "y", queries: ["orders"] });
      }
      return JSON.stringify({
        selectedEvidence: ["totally:fake:id"],
        candidateTarget: null,
        hypothesis: "",
        sufficient: true,
        clarificationQuestion: null,
        clarificationOptions: [],
      });
    });
    const result = await runInvestigationAgent(
      baseInput({ llm: LLM, report: "Something is wrong with orders." })
    );
    // No fallback to a fresh repository-wide investigation: unresolved
    // selection is an explicit insufficient-evidence state.
    expect(result.deterministic.status).toBe("AMBIGUOUS");
    expect(result.deterministic.plan).toBeNull();
  });

  it("falls back deterministically when the model errors", async () => {
    vi.mocked(chatComplete).mockRejectedValue(new Error("boom"));
    const result = await runInvestigationAgent(
      baseInput({ llm: LLM, report: "Refunding a payment twice should throw a cannot be refunded error." })
    );
    expect(result.modelUsed).toBe(false);
    expect(result.deterministic.status).toBe("READY");
  });

  it("resumes with a clarification answer instead of re-asking the whole bug", async () => {
    fakeModel([discountScenarioId], "createOrder");
    const result = await runInvestigationAgent(
      baseInput({
        llm: LLM,
        report: "Something is wrong with orders.",
        clarification: { priorQuestion: "Is the problem the order total?", answer: "Yes, the total." },
      })
    );
    const prompts = vi.mocked(chatComplete).mock.calls.map((c) => c[1].map((m) => m.content).join("\n"));
    expect(prompts.some((p) => p.includes("Yes, the total."))).toBe(true);
    expect(result.modelUsed).toBe(true);
  });
});
