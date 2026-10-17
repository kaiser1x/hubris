import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { persistedBuggyTwin, persistedHealthyTwin, savedDefectiveInvestigation } from "./helpers/ts-js-dummy";

// Independent replay of the ORIGINAL clarification loop through the real
// POST /api/investigate route: the exact reports the user submitted (runs 7-15
// of job 09c18031, recorded 2026-10-17), plus the report of the later saved run,
// against both persisted CodeTwins of kaiser1x/ts-js-dummy. The model is
// replaced by one that does what the real model did then: it cites nothing and
// asks implementation-detail questions ("where is seenIdempotencyKeys declared?
// what are the braces?"). None of that may reach the user, and no run may end
// in an unanswerable or repeated question.

const JOB_ID = "00000000-0000-0000-0000-000000000000";

const LOOP = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/ts-js-dummy/original-loop-runs.json", import.meta.url)), "utf8")
) as {
  runs: Array<{
    index: number;
    focus: string;
    recordedState: string;
    recordedMessage: string;
    recordedQuestion: string | null;
    recordedOptions: string[] | null;
  }>;
};
const DISTINCT_REPORTS = [...new Set([...LOOP.runs.map((r) => r.focus), savedDefectiveInvestigation().focus])];

const store = vi.hoisted(() => ({
  job: null as null | { id: string; repoUrl: string; status: string; result: any; error: null },
  llmMode: "off" as "off" | "detail-questions",
}));

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return {
    ...actual,
    chatComplete: vi.fn(async (_cfg: unknown, messages: Array<{ content: string }>) => {
      const text = messages.map((m) => m.content).join("\n");
      if (text.includes("Decompose the report")) {
        return JSON.stringify({
          observedBehavior: "A repeated idempotency key creates another payment",
          expectedBehavior: "The repeated key is rejected",
          entities: ["payment", "idempotency key"],
          actions: ["createPayment"],
          ambiguities: ["where seenIdempotencyKeys is declared"],
          queries: ["createPayment idempotency key"],
        });
      }
      // The recorded behavior: nothing cited, implementation-detail question.
      return JSON.stringify({
        selectedEvidence: [],
        candidateTarget: null,
        hypothesis: "",
        sufficient: false,
        clarificationQuestion:
          "What is the declaration and initialization of `seenIdempotencyKeys`, and what are the exact braces surrounding the `if` block in `createPayment`?",
        clarificationOptions: [
          "seenIdempotencyKeys is a `const Set` declared outside the function",
          "seenIdempotencyKeys is a `let` or `var` declared inside the function",
          "The `if` block lacks braces",
        ],
      });
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
            if (store.job) store.job = { ...store.job, result: v.result };
          },
        }),
      }),
    }),
  };
});

const REVISIONS = [
  ["buggy branch (hubris/buggy-idempotency)", () => persistedBuggyTwin(), "hubris/buggy-idempotency"],
  ["healthy main", () => persistedHealthyTwin(), "main"],
] as const;

function setJob(twin: ReturnType<typeof persistedBuggyTwin>, ref: string) {
  store.job = {
    id: JOB_ID,
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    error: null,
    result: {
      repository: { name: "kaiser1x/ts-js-dummy" },
      ref,
      commitSha: twin.commitSha,
      scripts: twin.scripts,
      packageManager: "pnpm",
      stats: { functions: twin.twin.functions.length, classes: 0, endpoints: 0, tests: twin.twin.tests.length, relationships: twin.twin.relationships.length },
      full: { ...twin.twin },
    },
  };
}

async function investigate(body: Record<string, unknown>) {
  const { app } = await import("../src/app");
  const res = await app.request("/api/investigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: JOB_ID, ...body }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

const IMPLEMENTATION_DETAIL = /declar|brace|initiali[sz]|module[- ]level|\bconst\b|\blet\b|re-?created|each (call|invocation)/i;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["off", "detail-questions"] as const)("original loop replay (model: %s)", (mode) => {
  beforeEach(() => {
    store.llmMode = mode;
    if (mode === "off") {
      vi.stubEnv("NEBIUS_API_KEY", "");
      vi.stubEnv("NEBIUS_MODEL", "");
    } else {
      vi.stubEnv("NEBIUS_API_KEY", "test-key-not-real");
      vi.stubEnv("NEBIUS_MODEL", "test-model");
    }
  });

  it("the recorded fixture really is the loop (guards against the fixture rotting)", () => {
    expect(LOOP.runs).toHaveLength(9);
    expect(LOOP.runs.every((r) => r.recordedState === "CLARIFICATION_NEEDED")).toBe(true);
    expect(LOOP.runs.some((r) => /contradictory/i.test(r.recordedMessage))).toBe(true);
    expect(LOOP.runs.some((r) => /braces/i.test(r.recordedQuestion ?? ""))).toBe(true);
  });

  describe.each(REVISIONS)("%s", (_name, twin, ref) => {
    it.each(DISTINCT_REPORTS.map((r, i) => [i, r] as const))(
      "report #%i reaches a grounded contract with no question",
      async (_i, report) => {
        setJob(twin(), ref);
        const out = await investigate({ focus: report });
        expect(out.status).toBe(200);
        expect(out.data.message).not.toMatch(/contradictory/i);
        expect(out.data.state).toBe("READY_FOR_REVIEW");
        expect(out.data.clarification).toBeNull();
        expect(out.data.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
        // Contract quality: specific Expected, honest condition, preserved message.
        expect(out.data.plan.expectedBehavior).not.toMatch(/^The requested entity must be/);
        expect(out.data.plan.expectedBehavior).toContain("to throw");
        expect(JSON.stringify(out.data.plan.repairContract)).not.toContain("TRAIL");
        if (ref === "hubris/buggy-idempotency") {
          expect(out.data.plan.repairContract.conditionKind).toBe("presence-precondition");
        } else {
          expect(out.data.plan.repairContract.conditionKind).toBe("causal-guard");
        }
      }
    );

    it("clicking one of the recorded old options (legacy free text) does not loop either", async () => {
      setJob(twin(), ref);
      const old = LOOP.runs.find((r) => r.recordedOptions?.length)!;
      const answered = await investigate({
        focus: old.focus,
        priorQuestion: old.recordedQuestion ?? "",
        clarification: old.recordedOptions![0],
      });
      expect(answered.data.state).toBe("READY_FOR_REVIEW");
      expect(answered.data.clarification).toBeNull();
    });

    it("never surfaces an implementation-detail question or a truncated-report question", async () => {
      setJob(twin(), ref);
      for (const report of DISTINCT_REPORTS) {
        const out = await investigate({ focus: report });
        const q = out.data.clarification?.question ?? "";
        expect(q).not.toMatch(IMPLEMENTATION_DETAIL);
        expect(q).not.toMatch(/^Which behavior is wrong in/);
        for (const o of out.data.clarification?.options ?? []) expect(o.label).not.toMatch(IMPLEMENTATION_DETAIL);
      }
    });
  });
});
