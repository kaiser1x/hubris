import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { analyzeFixtureTwin, type TwinInput } from "./helpers/ts-js-dummy";

// POST /api/investigate through the REAL route with a stateful in-memory job
// store: the persisted investigation records are what the next request reads,
// exactly as with the database.

const JOB_ID = "00000000-0000-0000-0000-000000000000";
const VAGUE = "Users cannot be found sometimes.";

const store = vi.hoisted(() => ({
  job: null as null | { id: string; repoUrl: string; status: string; result: any; error: null },
  updates: 0,
  llmCalls: 0,
}));

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return {
    ...actual,
    chatComplete: vi.fn(async () => {
      store.llmCalls += 1;
      throw new Error("model must not be needed");
    }),
  };
});

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  return {
    ...actual,
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => (store.job ? [store.job] : []) }) }),
      update: () => ({
        set: (v: { result?: unknown }) => ({
          where: async () => {
            store.updates += 1;
            if (store.job) store.job = { ...store.job, result: v.result };
          },
        }),
      }),
    }),
  };
});

let TWIN: TwinInput;
beforeAll(async () => {
  TWIN = await analyzeFixtureTwin();
});

beforeEach(() => {
  store.updates = 0;
  store.llmCalls = 0;
  store.job = {
    id: JOB_ID,
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    error: null,
    result: {
      repository: { name: "kaiser1x/ts-js-dummy" },
      ref: "hubris/buggy-idempotency",
      commitSha: "b".repeat(40),
      scripts: { test: "vitest run" },
      packageManager: "pnpm",
      stats: { functions: TWIN.functions.length, classes: 0, endpoints: 0, tests: TWIN.tests.length, relationships: TWIN.relationships.length },
      full: { ...TWIN },
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function post(body: Record<string, unknown>) {
  vi.stubEnv("NEBIUS_API_KEY", "");
  vi.stubEnv("NEBIUS_MODEL", "");
  vi.stubEnv("NEBIUS_PROJECT_ID", "");
  const { app } = await import("../src/app");
  const res = await app.request("/api/investigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: JOB_ID, ...body }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

const runs = () => (store.job!.result.investigationRuns ?? []) as any[];

describe("POST /api/investigate clarification round-trip", () => {
  it("asks a grounded question with stable ids, then pins the answer and persists it", async () => {
    const first = await post({ focus: VAGUE });
    expect(first.status).toBe(200);
    expect(first.data.state).toBe("CLARIFICATION_NEEDED");
    const q = first.data.clarification;
    expect(q.questionId).toMatch(/^q_/);
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    expect(q.options.every((o: any) => /^opt_/.test(o.id) && o.label && o.function && o.scenario)).toBe(true);
    expect(runs()).toHaveLength(1);
    expect(runs()[0].clarification.questionId).toBe(q.questionId);

    const choice = q.options.find((o: any) => o.scenario === "rejects unknown users");
    const second = await post({
      focus: VAGUE,
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: q.questionId, optionId: choice.id },
    });
    expect(second.status).toBe(200);
    // New run, new identity — bound to the SAME job and linked to the question it answered.
    expect(second.data.investigationId).not.toBe(first.data.investigationId);
    expect(second.data.clarification).toBeNull();
    expect(second.data.answer).toMatchObject({
      priorInvestigationId: first.data.investigationId,
      questionId: q.questionId,
      optionId: choice.id,
    });
    expect(second.data.relevantScenarios[0]).toContain("rejects unknown users");
    expect(second.data.selections).toHaveLength(1);
    expect(second.data.askedOptionSets).toEqual([q.optionSetKey]);
    // Persisted for the next stage and for retries.
    expect(runs()).toHaveLength(2);
    expect(runs()[1].selections[0].optionId).toBe(choice.id);
    expect(runs()[1].answer.priorInvestigationId).toBe(first.data.investigationId);
    expect(runs()[1].jobId).toBe(JOB_ID);
  });

  it("rejects a forged option id (400) without persisting or calling the model", async () => {
    const first = await post({ focus: VAGUE });
    const before = store.updates;
    const bad = await post({
      focus: VAGUE,
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: first.data.clarification.questionId, optionId: "opt_forged000000" },
    });
    expect(bad.status).toBe(400);
    expect(bad.data.code).toBe("INVALID_OPTION");
    expect(store.updates).toBe(before);
    expect(store.llmCalls).toBe(0);
  });

  it("rejects a stale question id, a changed description, and an unknown prior run (409)", async () => {
    const first = await post({ focus: VAGUE });
    const q = first.data.clarification;
    const optionId = q.options[0].id;
    const before = store.updates;

    const stale = await post({
      focus: VAGUE,
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: "q_000000000000", optionId },
    });
    expect([stale.status, stale.data.code]).toEqual([409, "STALE_QUESTION"]);

    const changed = await post({
      focus: "Something completely different.",
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: q.questionId, optionId },
    });
    expect([changed.status, changed.data.code]).toEqual([409, "REPORT_CHANGED"]);

    const unknown = await post({
      focus: VAGUE,
      priorInvestigationId: "inv-does-not-exist",
      answer: { questionId: q.questionId, optionId },
    });
    expect([unknown.status, unknown.data.code]).toEqual([409, "PRIOR_NOT_FOUND"]);

    expect(store.updates).toBe(before);
    expect(runs()).toHaveLength(1);
  });

  it("rejects answering the same question twice (409) and does not create a third run", async () => {
    const first = await post({ focus: VAGUE });
    const q = first.data.clarification;
    const body = {
      focus: VAGUE,
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: q.questionId, optionId: q.options[0].id },
    };
    expect((await post(body)).status).toBe(200);
    const again = await post(body);
    expect([again.status, again.data.code]).toEqual([409, "ALREADY_ANSWERED"]);
    expect(runs()).toHaveLength(2);
  });

  it("requires the prior investigation id with a structured answer (400)", async () => {
    const first = await post({ focus: VAGUE });
    const missing = await post({
      focus: VAGUE,
      answer: { questionId: first.data.clarification.questionId, optionId: first.data.clarification.options[0].id },
    });
    expect([missing.status, missing.data.code]).toEqual([400, "MISSING_PRIOR"]);
  });

  it("a concrete report never produces a question", async () => {
    const out = await post({
      focus:
        "createPayment() in src/payments.ts accepts a duplicate idempotency key. The second call must throw an error containing `duplicate payment for key`.",
    });
    expect(out.status).toBe(200);
    expect(out.data.status).toBe("READY");
    expect(out.data.clarification).toBeNull();
    expect(out.data.state).toBe("READY_FOR_REVIEW");
  });

  it("the legacy free-text answer path still works and is a hint only", async () => {
    const out = await post({ focus: VAGUE, priorQuestion: "Which behavior?", clarification: "the unknown user lookup" });
    expect(out.status).toBe(200);
    expect(out.data.selections).toEqual([]);
    expect(out.data.answer).toBeNull();
  });
});
