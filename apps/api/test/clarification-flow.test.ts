import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return { ...actual, chatComplete: vi.fn(async () => "") };
});

import { chatComplete } from "@hubris/llm";
import {
  optionSetKeyOf,
  resolveClarificationAnswer,
  runInvestigationAgent,
  type ClarificationOption,
  type ClarificationSelection,
  type RunInvestigationAgentInput,
} from "../src/investigate-agent";
import { analyzeFixtureTwin, type TwinInput } from "./helpers/ts-js-dummy";

// Clarification behavior on the controlled ts-js-dummy repository: meaningful,
// evidence-grounded, stable-id questions; authoritative answers; no repeats;
// specific blocked states instead of unanswerable questions.

const VAGUE = "Users cannot be found sometimes.";
const LLM = { apiKey: "k", model: "m", baseUrl: "http://llm.invalid" } as unknown as NonNullable<
  RunInvestigationAgentInput["llm"]
>;

let TWIN: TwinInput;
beforeAll(async () => {
  TWIN = await analyzeFixtureTwin();
});
beforeEach(() => {
  vi.mocked(chatComplete).mockReset();
  vi.mocked(chatComplete).mockRejectedValue(new Error("model offline"));
});

function run(over: Partial<RunInvestigationAgentInput> = {}) {
  return runInvestigationAgent({
    llm: null,
    jobId: "job-1",
    repository: "kaiser1x/ts-js-dummy",
    report: VAGUE,
    ...TWIN,
    ...over,
  });
}

function selectionFor(option: ClarificationOption, questionId = "q_x"): ClarificationSelection {
  return { questionId, optionId: option.id, option };
}

describe("meaningful, evidence-grounded clarification", () => {
  it("asks only when several viable interpretations exist, offering existing test scenarios", async () => {
    const out = await run();
    expect(out.state).toBe("CLARIFICATION_NEEDED");
    const q = out.clarification!;
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    const scenarios = new Set(TWIN.sourceFacts.map((f) => String(f.text)));
    for (const option of q.options) {
      // Every choice is a real scenario and a real function of the twin.
      expect(TWIN.functions.some((f) => f.name === option.function)).toBe(true);
      expect(option.id).toMatch(/^opt_[0-9a-f]{12}$/);
      expect([...scenarios].some((t) => t.includes(option.scenario))).toBe(true);
    }
    expect(q.questionId).toMatch(/^q_[0-9a-f]{12}$/);
    // The question never echoes a truncated report and never asks about
    // implementation details.
    expect(q.question).not.toContain(VAGUE.slice(0, 20));
    expect(q.question).not.toMatch(/declared|brace|initiali[sz]|module[- ]level|\blet\b|\bconst\b/i);
  });

  it("uses stable ids: the same evidence yields the same question and option ids", async () => {
    const a = (await run()).clarification!;
    const b = (await run()).clarification!;
    expect(b.questionId).toBe(a.questionId);
    expect(b.optionSetKey).toBe(a.optionSetKey);
    expect(b.options.map((o) => o.id)).toEqual(a.options.map((o) => o.id));
    expect(a.optionSetKey).toBe(optionSetKeyOf(a.options));
  });

  it("ignores model-written questions and options (implementation-detail questions never reach the user)", async () => {
    vi.mocked(chatComplete).mockImplementation(async (_cfg, messages) => {
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("Decompose the report")) {
        return JSON.stringify({ observedBehavior: "users missing", expectedBehavior: "users found", queries: ["user lookup"] });
      }
      return JSON.stringify({
        selectedEvidence: [],
        candidateTarget: null,
        hypothesis: "",
        sufficient: false,
        clarificationQuestion: "Is `seenIdempotencyKeys` declared with let or const, and where are the braces?",
        clarificationOptions: ["It is a const Set", "It is declared inside the function"],
      });
    });
    const out = await run({ llm: LLM });
    expect(out.modelUsed).toBe(true);
    expect(out.state).toBe("CLARIFICATION_NEEDED");
    expect(out.clarification!.question).not.toMatch(/declared|braces|const Set/i);
    for (const option of out.clarification!.options) {
      expect(option.label).not.toMatch(/const Set|declared inside/i);
    }
  });

  it("a concrete report needs no clarification at all", async () => {
    const out = await run({
      report:
        "createPayment() in src/payments.ts accepts a duplicate idempotency key. The second call must throw an error containing `duplicate payment for key`.",
    });
    expect(out.clarification).toBeNull();
    expect(out.blocked).toBeNull();
    expect(out.state).toBe("READY_FOR_REVIEW");
  });
});

describe("the selected answer is authoritative", () => {
  it("pins the chosen scenario and its function into the contract evidence", async () => {
    const asked = (await run()).clarification!;
    const chosen = asked.options.find((o) => o.scenario === "rejects unknown users")!;
    expect(chosen).toBeDefined();
    const out = await run({ selections: [selectionFor(chosen, asked.questionId)] });
    expect(out.clarification).toBeNull();
    expect(out.relevantScenarios[0]).toContain("rejects unknown users");
    expect(out.retrievedEvidence[0].function).toBe(chosen.function);
    expect(out.retrievedEvidence.some((e) => e.sourceType === "test" && e.text.includes("rejects unknown users"))).toBe(true);
    expect(out.selections).toHaveLength(1);
    expect(out.selections[0].optionId).toBe(chosen.id);
  });

  it("is not lost when a later model call selects different evidence", async () => {
    const asked = (await run()).clarification!;
    const chosen = asked.options.find((o) => o.scenario === "getUser throws for unknown ids")!;
    // The model "cites" nothing and proposes another target; the pinned
    // selection must still drive the evidence.
    vi.mocked(chatComplete).mockImplementation(async (_cfg, messages) => {
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("Decompose the report")) {
        return JSON.stringify({ observedBehavior: "x", expectedBehavior: "y", queries: ["payment"] });
      }
      return JSON.stringify({ selectedEvidence: [], candidateTarget: "createPayment", hypothesis: "h", sufficient: true });
    });
    const out = await run({ llm: LLM, selections: [selectionFor(chosen, asked.questionId)] });
    expect(out.retrievedEvidence[0].function).toBe(chosen.function);
    expect(out.relevantScenarios.join(" ")).toContain("getUser throws for unknown ids");
  });

  it("never re-asks after an answer: an unresolved contract becomes a specific blocked state", async () => {
    const asked = (await run()).clarification!;
    const chosen = asked.options.find((o) => o.scenario === "getUser throws for unknown ids")!;
    const out = await run({ selections: [selectionFor(chosen, asked.questionId)] });
    expect(out.clarification).toBeNull();
    if (out.state !== "READY_FOR_REVIEW") {
      expect(out.state).toBe("AMBIGUOUS");
      expect(out.blocked).not.toBeNull();
      expect(out.blocked!.reason).toMatch(/^Your selection was applied, but /);
      expect(out.blocked!.nextStep.length).toBeGreaterThan(20);
    }
  });

  it("carries earlier answers through a retry", async () => {
    const asked = (await run()).clarification!;
    const [first, second] = asked.options;
    const out = await run({
      selections: [selectionFor(first, "q_a"), selectionFor(second, "q_b")],
    });
    expect(out.selections.map((s) => s.optionId)).toEqual([first.id, second.id]);
    // The most recent answer is the one pinned.
    expect(out.retrievedEvidence.some((e) => e.sourceType === "test" && e.text.includes(second.scenario))).toBe(true);
  });

  it("a selection whose scenario no longer exists fails safely", async () => {
    const asked = (await run()).clarification!;
    const ghost: ClarificationOption = { ...asked.options[0], scenario: "no longer exists", id: "opt_ghost" };
    const out = await run({ selections: [selectionFor(ghost)] });
    expect(out.state).toBe("AMBIGUOUS");
    expect(out.clarification).toBeNull();
    expect(out.blocked?.code).toBe("EVIDENCE_UNRESOLVED");
  });
});

describe("no repeated questions without progress", () => {
  it("does not ask an equivalent question twice in the same conversation", async () => {
    const first = (await run()).clarification!;
    const out = await run({ askedOptionSets: [first.optionSetKey] });
    expect(out.clarification).toBeNull();
    expect(out.state).toBe("AMBIGUOUS");
    expect(out.blocked?.code).toBe("REPEATED_QUESTION");
    expect(out.blocked?.nextStep).toMatch(/already asked/i);
  });
});

describe("blocked states are specific and actionable", () => {
  it("a genuinely contradictory report is blocked, not turned into a question", async () => {
    const out = await run({ report: "The retry should create another payment and also reject the retry." });
    expect(out.clarification).toBeNull();
    expect(out.state).toBe("AMBIGUOUS");
    expect(out.blocked?.code).toBe("CONTRADICTORY_REPORT");
    expect(out.blocked?.nextStep).toMatch(/expected behavior/i);
  });

  it("missing evidence is NO_MATCH, never a question", async () => {
    const out = await run({ report: "The hologram projector is misconfigured." });
    expect(out.state).toBe("NO_MATCH");
    expect(out.clarification).toBeNull();
  });

  it("an ambiguity with a single candidate scenario is blocked with a reason, not asked", async () => {
    // Nothing to choose between: one function, one scenario, and that scenario
    // asserts nothing. Asking the user would not add repository evidence.
    const single: TwinInput = {
      functions: [{ name: "normalizeName", path: "src/names.ts", line: 1, endLine: 3 }],
      tests: [{ file: "tests/names.test.ts", name: "names.test", path: "tests/names.test.ts" }],
      relationships: [],
      sourceFacts: [
        { path: "src/names.ts", line: 1, kind: "source", text: "export function normalizeName(name: string): string {" },
        { path: "src/names.ts", line: 2, kind: "source", text: "return name.trim();" },
        { path: "tests/names.test.ts", line: 1, kind: "test", text: 'it("normalizes names", () => {' },
        { path: "tests/names.test.ts", line: 2, kind: "test", text: 'normalizeName(" ada ");' },
      ],
    };
    const out = await run({ ...single, report: "normalizeName returns names with extra whitespace." });
    expect(out.clarification).toBeNull();
    expect(out.state).toBe("AMBIGUOUS");
    expect(out.blocked?.code).toBe("SCENARIO_ASSERTS_NOTHING");
    expect(out.blocked?.nextStep).toMatch(/assert/i);
  });
});

describe("resolveClarificationAnswer (server-side validation)", () => {
  const JOB = "job-1";
  const REPORT = VAGUE;
  let asked: NonNullable<Awaited<ReturnType<typeof run>>["clarification"]>;
  let priorRun: Record<string, unknown>;

  beforeAll(async () => {
    asked = (await run()).clarification!;
    priorRun = {
      investigationId: "inv-prior",
      jobId: JOB,
      focus: REPORT,
      clarification: asked,
      selections: [],
      askedOptionSets: [],
    };
  });

  const answer = (over: Record<string, unknown> = {}) => ({
    priorInvestigationId: "inv-prior",
    answer: { questionId: asked.questionId, optionId: asked.options[0].id, ...over },
  });

  it("accepts a valid answer and resolves the option from the PERSISTED question", () => {
    const r = resolveClarificationAnswer([priorRun], answer() as never, REPORT, JOB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selections).toHaveLength(1);
    expect(r.selections[0].option).toEqual(asked.options[0]);
    expect(r.askedOptionSets).toEqual([asked.optionSetKey]);
    expect(r.answer.priorInvestigationId).toBe("inv-prior");
  });

  it("rejects an option id that was not offered (400)", () => {
    const r = resolveClarificationAnswer([priorRun], answer({ optionId: "opt_forged" }) as never, REPORT, JOB);
    expect(r).toMatchObject({ ok: false, code: "INVALID_OPTION", status: 400 });
  });

  it("rejects a stale question id (409)", () => {
    const r = resolveClarificationAnswer([priorRun], answer({ questionId: "q_old" }) as never, REPORT, JOB);
    expect(r).toMatchObject({ ok: false, code: "STALE_QUESTION", status: 409 });
  });

  it("rejects an unknown or other-job prior investigation (409)", () => {
    expect(
      resolveClarificationAnswer([priorRun], { ...answer(), priorInvestigationId: "inv-nope" } as never, REPORT, JOB)
    ).toMatchObject({ ok: false, code: "PRIOR_NOT_FOUND", status: 409 });
    expect(resolveClarificationAnswer([priorRun], answer() as never, REPORT, "other-job")).toMatchObject({
      ok: false,
      code: "PRIOR_NOT_FOUND",
    });
  });

  it("requires the prior investigation id (400)", () => {
    const r = resolveClarificationAnswer([priorRun], { answer: answer().answer } as never, REPORT, JOB);
    expect(r).toMatchObject({ ok: false, code: "MISSING_PRIOR", status: 400 });
  });

  it("rejects an answer when the description changed since the question was asked (409)", () => {
    const r = resolveClarificationAnswer([priorRun], answer() as never, "A different report entirely.", JOB);
    expect(r).toMatchObject({ ok: false, code: "REPORT_CHANGED", status: 409 });
  });

  it("tolerates whitespace/case differences in the same description", () => {
    const r = resolveClarificationAnswer([priorRun], answer() as never, `  ${REPORT.toUpperCase()}  `, JOB);
    expect(r.ok).toBe(true);
  });

  it("rejects answering the same question twice (409)", () => {
    const answered = { investigationId: "inv-next", jobId: JOB, answer: { priorInvestigationId: "inv-prior" } };
    const r = resolveClarificationAnswer([priorRun, answered], answer() as never, REPORT, JOB);
    expect(r).toMatchObject({ ok: false, code: "ALREADY_ANSWERED", status: 409 });
  });

  it("rejects an answer to a run that asked no question (409)", () => {
    const silent = { investigationId: "inv-prior", jobId: JOB, focus: REPORT, clarification: null };
    expect(resolveClarificationAnswer([silent], answer() as never, REPORT, JOB)).toMatchObject({
      ok: false,
      code: "NO_OPEN_QUESTION",
      status: 409,
    });
  });

  it("carries earlier selections and asked sets forward", () => {
    const earlier = selectionFor(asked.options[1], "q_earlier");
    const chained = { ...priorRun, selections: [earlier], askedOptionSets: ["key-earlier"] };
    const r = resolveClarificationAnswer([chained], answer() as never, REPORT, JOB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.selections.map((s) => s.optionId)).toEqual([asked.options[1].id, asked.options[0].id]);
    expect(r.askedOptionSets).toEqual(["key-earlier", asked.optionSetKey]);
  });
});
