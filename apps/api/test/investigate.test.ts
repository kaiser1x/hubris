// Deterministic investigator tests (no model, no exec, no I/O). The
// fixture twin mirrors the real ts-js-dummy CodeTwin shapes (function
// names/paths, suite test names, IMPORTS/CALLS relationships) so verdicts
// proven here transfer to the live job.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  composeForgeFocus,
  investigateTwin,
  type InvestigateInput,
} from "../src/investigate";

const FUNCTIONS = [
  { name: "createPayment", path: "src/payments.ts", line: 30, endLine: 45 },
  { name: "getUser", path: "src/users.ts", line: 10, endLine: 18 },
  { name: "validatePayment", path: "src/payments.ts", line: 10, endLine: 18 },
  { name: "savePayment", path: "src/payments.ts", line: 20, endLine: 27 },
  { name: "sendNotification", path: "src/notifications.ts", line: 5, endLine: 12 },
  { name: "findUser", path: "src/users.ts", line: 20, endLine: 28 },
];

const TESTS = [
  { name: "idempotency-regression.test", path: "tests/idempotency-regression.test.ts" },
  { name: "payments.test", path: "tests/payments.test.ts" },
  { name: "users.test", path: "tests/users.test.ts" },
];

const RELATIONSHIPS = [
  { from: "tests/idempotency-regression.test.ts", to: "../src/payments.js", type: "IMPORTS" },
  { from: "tests/payments.test.ts", to: "../src/payments.js", type: "IMPORTS" },
  { from: "tests/users.test.ts", to: "../src/users.js", type: "IMPORTS" },
  { from: "createPayment", to: "getUser", type: "CALLS" },
  { from: "createPayment", to: "savePayment", type: "CALLS" },
  { from: "createPayment", to: "seenIdempotencyKeys.add", type: "CALLS" },
  { from: "getUser", to: "findUser", type: "CALLS" },
  { caller: "endpoint:POST:/payments", to: "createPayment", type: "CALLS" },
];

const SOURCE_FACTS = [
  { path: "src/payments.ts", line: 35, kind: "source" as const, text: "if (idempotencyKey !== undefined) {" },
  { path: "src/payments.ts", line: 36, kind: "source" as const, text: "seenIdempotencyKeys.add(idempotencyKey);" },
  { path: "tests/idempotency-regression.test.ts", line: 12, kind: "test" as const, text: "expect(() => createPayment(...)).toThrow(/duplicate/i);" },
  { path: "tests/payments.test.ts", line: 30, kind: "test" as const, text: "expect(() => createPayment(...)).toThrow(\"duplicate payment\");" },
  { path: "tests/payments.test.ts", line: 18, kind: "test" as const, text: "creates a completed payment and notifies" },
];

function input(focus: string, over: Partial<InvestigateInput> = {}): InvestigateInput {
  return {
    focus,
    functions: FUNCTIONS,
    tests: TESTS,
    relationships: RELATIONSHIPS,
    sourceFacts: SOURCE_FACTS,
    ...over,
  };
}

const updateCalls: unknown[][] = [];
const persistedUpdates: unknown[] = [];

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  const job = {
    id: "00000000-0000-0000-0000-000000000000",
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    result: {
      repository: { name: "kaiser1x/ts-js-dummy" },
      stats: { functions: 6, classes: 0, endpoints: 1, tests: 3, relationships: 7 },
      full: { functions: FUNCTIONS, tests: TESTS, relationships: RELATIONSHIPS, sourceFacts: SOURCE_FACTS },
    },
    error: null,
  };
  return {
    ...actual,
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [job] }) }),
      update: (...args: unknown[]) => {
        updateCalls.push(args);
        return {
          set: (value: unknown) => {
            persistedUpdates.push(value);
            return { where: async () => undefined };
          },
        };
      },
    }),
  };
});

describe("investigateTwin verdicts", () => {
  it("specific bug resolves READY with the exact target", () => {
    const r = investigateTwin(
      input("duplicate idempotency keys are accepted instead of rejected")
    );
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(r.plan.evidence.join("\n")).toContain("idempotency-regression.test");
    expect(r.plan.constraints.join("\n")).toContain("smallest possible change");
    expect(["low", "medium", "high"]).toContain(r.plan.confidence);
  });

  it("does not forge a target without a concrete repository contract", () => {
    const r = investigateTwin(input("sending notifications is broken"));
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });

  it("resolves a behavioral retry report using repository evidence", () => {
    const r = investigateTwin(input("Payments are sometimes getting charged twice when customers retry."));
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(r.plan.evidence.join("\n")).toContain("idempotency-regression.test");
    expect(r.plan.repairContract.existingErrorContract).toContain("duplicate");
    expect(r.plan.repairContract.requiredOutcome).toContain("throw");
    expect(r.plan.repairContract.existingErrorContract).toContain("duplicate");
    expect(r.plan.repairContract.relevantCondition).toContain("idempotencyKey");
    expect(r.plan.repairContract.relevantOperation).toContain("seenIdempotencyKeys.add");
    // The only enclosing guard tests key PRESENCE; it is not the duplicate
    // guard, so the contract asks for the missing check instead of telling the
    // repair to "preserve the existing condition".
    expect(r.plan.repairContract.conditionKind).toBe("presence-precondition");
    expect(r.plan.repairContract.minimalRepairDescription).toContain("Add the missing check");
    expect(r.plan.repairContract.minimalRepairDescription).not.toContain("existing condition");
  });

  it("ignores generic repair prose that collides with unrelated symbols", () => {
    const r = investigateTwin(
      input(
        "Customers can be charged more than once when they retry the same payment with the same idempotency key. The second attempt with an already-used key should be rejected instead of creating another payment. Preserve the existing duplicate-payment error behavior and all unrelated payment logic, and make only the minimal change necessary to prevent the duplicate charge."
      )
    );
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(r.plan.repairContract.requiredOutcome).toContain("throw");
  });

  it("does not guess from a broad domain noun", () => {
    const r = investigateTwin(input("The payment thing is broken."));
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });

  it("ambiguous bug returns AMBIGUOUS with candidates, never a guess", () => {
    const r = investigateTwin(input("user lookup fails"));
    expect(r.status).toBe("AMBIGUOUS");
    if (r.status !== "AMBIGUOUS") return;
    expect(r.message).toContain("getUser");
    expect(r.message).toContain("findUser");
    expect(r.plan).toBeNull();
  });

  it("nonexistent bug returns NO_MATCH", () => {
    const r = investigateTwin(input("quantum flux capacitor orbit decaying"));
    expect(r.status).toBe("NO_MATCH");
    if (r.status !== "NO_MATCH") return;
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.plan).toBeNull();
  });

  it("empty focus and empty twin degrade to NO_MATCH without throwing", () => {
    expect(investigateTwin(input("")).status).toBe("NO_MATCH");
    expect(investigateTwin(input("duplicate keys", { functions: [] })).status).toBe("NO_MATCH");
    expect(
      investigateTwin({ focus: "x", functions: "nope" } as unknown as InvestigateInput).status
    ).toBe("NO_MATCH");
  });

  it("is pure: same input always yields the same verdict, no side channels", () => {
    const a = investigateTwin(input("duplicate idempotency keys are accepted"));
    const b = investigateTwin(input("duplicate idempotency keys are accepted"));
    expect(a).toEqual(b);
  });

  it("never invents files or functions outside the twin", () => {
    const r = investigateTwin(input("duplicate idempotency keys are accepted"));
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    const knownFiles = new Set(FUNCTIONS.map((f) => f.path));
    const knownNames = new Set(FUNCTIONS.map((f) => f.name));
    expect(knownFiles.has(r.plan.target.file)).toBe(true);
    expect(knownNames.has(r.plan.target.function)).toBe(true);
    for (const line of r.plan.evidence) {
      expect(line).not.toMatch(/quantum|orbit|flux/i);
    }
  });
});

describe("composeForgeFocus", () => {
  it("carries the complete Forge contract within the structured focus limit", () => {
    const r = investigateTwin(input("duplicate idempotency keys are accepted"));
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    const focus = composeForgeFocus(r.plan);
    expect(focus.length).toBeGreaterThan(0);
    expect(focus.length).toBeLessThanOrEqual(2000);
    expect(focus).toContain("createPayment");
    expect(focus).toContain("src/payments.ts");
    expect(focus).toContain("Required outcome");
  });
});

// Repository-agnostic grounding: a twin whose tests are named by module
// (payments.test, orders.test) rather than by behavior must still ground a
// repair contract through IMPORTS edges to the target file. This mirrors a
// real non-demo repository (e.g. the commerce CodeTwin) — no keyword in the
// test names matches the old name-only heuristic. Line ranges are real (the
// analyzer now records them).
describe("module-named test linking (non-demo twin)", () => {
  const MODULE_TESTS = [
    { name: "payments.test", path: "tests/payments.test.ts" },
    { name: "orders.test", path: "tests/orders.test.ts" },
  ];
  const MODULE_RELATIONSHIPS = [
    { from: "tests/payments.test.ts", to: "../src/payments.js", type: "IMPORTS" },
    { from: "tests/orders.test.ts", to: "../src/orders.js", type: "IMPORTS" },
    { from: "refund", to: "getPayment", type: "CALLS", caller: "refund" },
    { caller: "endpoint:POST:/payments/refund", to: "refund", type: "CALLS" },
  ];
  const MODULE_FACTS = [
    { path: "src/payments.ts", line: 57, kind: "source" as const, text: "if (!payment) throw new Error(`Unknown payment: ${paymentId}`)" },
    { path: "src/payments.ts", line: 63, kind: "source" as const, text: "if (payment.status !== 'succeeded') {" },
    { path: "src/payments.ts", line: 64, kind: "source" as const, text: "throw new Error(`Payment ${paymentId} cannot be refunded (status: ${payment.status})`)" },
    { path: "src/payments.ts", line: 66, kind: "source" as const, text: "store.payments.set(payment.id, { ...payment, status: 'refunded' })" },
    { path: "tests/payments.test.ts", line: 41, kind: "test" as const, text: "it('rejects refunding a payment twice', () => {" },
    { path: "tests/payments.test.ts", line: 42, kind: "test" as const, text: "expect(() => refund(payment.id)).toThrow(/cannot be refunded/)" },
  ];

  it("grounds a READY plan using IMPORTS-linked module-named tests", () => {
    const r = investigateTwin({
      focus: "Refunding a payment twice should throw a cannot be refunded error instead of succeeding a second time",
      functions: [
        { name: "refund", path: "src/payments.ts", line: 61, endLine: 68 },
        { name: "getPaymentOrThrow", path: "src/payments.ts", line: 55, endLine: 59 },
        { name: "createPayment", path: "src/payments.ts", line: 32, endLine: 49 },
        { name: "getPayment", path: "src/payments.ts", line: 51, endLine: 53 },
        { name: "shipOrder", path: "src/orders.ts", line: 50, endLine: 58 },
      ],
      tests: MODULE_TESTS,
      relationships: MODULE_RELATIONSHIPS,
      sourceFacts: MODULE_FACTS,
    });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target).toEqual({ file: "src/payments.ts", function: "refund" });
    expect(r.plan.repairContract.requiredOutcome).toContain("throw");
    expect(r.plan.repairContract.existingErrorContract).toContain("cannot be refunded");
    expect(r.plan.repairContract.relevantCondition).toContain("status");
    expect(r.plan.repairContract.relevantOperation).toContain("store.payments.set");
    expect(r.plan.repairContract.minimalRepairDescription).toContain("existing condition");
    // The contract must NOT be contaminated by unrelated facts in the same
    // file (createPayment / getPaymentOrThrow live outside refund's range).
    expect(r.plan.repairContract.relevantCondition).not.toContain("Unknown payment");
    expect(r.plan.evidence.join("\n")).not.toContain("Unknown payment");
  });
});

describe("POST /api/investigate focus mode (mocked db, no model)", () => {
  async function postFocus(body: object) {
    // Dynamic import keeps the module registry (and the db mock above)
    // intact across tests in this file.
    const { app } = await import("../src/app");
    return app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", ...body }),
    });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    updateCalls.length = 0;
    persistedUpdates.length = 0;
  });

  it("specific bug returns READY without model configuration", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "");
    vi.stubEnv("NEBIUS_MODEL", "");
    const res = await postFocus({ focus: "duplicate idempotency keys are accepted" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe("READY");
    expect(data.jobId).toBe("00000000-0000-0000-0000-000000000000");
    expect(typeof data.investigationId).toBe("string");
    expect(typeof data.createdAt).toBe("string");
    const plan = data.plan as Record<string, unknown>;
    expect(plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(plan.confidence).toMatch(/^(low|medium|high)$/);

    const update = persistedUpdates[0] as {
      result?: { investigationRuns?: Array<Record<string, unknown>> };
    };
    const saved = update.result?.investigationRuns?.[0];
    expect(saved?.jobId).toBe(data.jobId);
    expect(saved?.investigationId).toBe(data.investigationId);
    expect(saved?.status).toBe("READY");
  });

  it("ambiguous and unmatched bugs return explicit verdicts, never edits", async () => {
    const amb = await postFocus({ focus: "user lookup fails" });
    expect(amb.status).toBe(200);
    expect(((await amb.json()) as Record<string, unknown>).status).toBe("AMBIGUOUS");
    const none = await postFocus({ focus: "quantum flux capacitor orbit decaying" });
    expect(none.status).toBe(200);
    expect(((await none.json()) as Record<string, unknown>).status).toBe("NO_MATCH");
  });

  it("persists the investigation record without touching repository execution", async () => {
    await postFocus({ focus: "duplicate idempotency keys are accepted" });
    expect(updateCalls).toHaveLength(1);
  });

  it("persists the richer state, evidence, and exact job identity", async () => {
    await postFocus({ focus: "duplicate idempotency keys are accepted" });
    const update = persistedUpdates[0] as {
      result?: { investigationRuns?: Array<Record<string, unknown>> };
    };
    const saved = update.result?.investigationRuns?.[0];
    expect(saved?.jobId).toBe("00000000-0000-0000-0000-000000000000");
    expect(saved?.state).toBe("READY_FOR_REVIEW");
    expect(Array.isArray(saved?.retrievedEvidence)).toBe(true);
    expect((saved?.retrievedEvidence as unknown[]).length).toBeGreaterThan(0);
    const source = saved?.source as Record<string, unknown>;
    expect(source?.jobId).toBe("00000000-0000-0000-0000-000000000000");
    expect("commitSha" in (source ?? {})).toBe(true);
  });

  it("accepts a resubmission carrying a clarification answer", async () => {
    const res = await postFocus({
      focus: "duplicate idempotency keys are accepted",
      priorQuestion: "Which behavior is wrong?",
      clarification: "The duplicate key path.",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("READY");
  });

  it("legacy question mode still requires model configuration", async () => {
    vi.stubEnv("NEBIUS_API_KEY", "");
    vi.stubEnv("NEBIUS_MODEL", "");
    const res = await postFocus({ question: "where is the bug?" });
    expect(res.status).toBe(503);
  });

  it("rejects missing jobId and overlong focus", async () => {
    const { app } = await import("../src/app");
    const noJob = await app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus: "duplicate keys" }),
    });
    expect(noJob.status).toBe(400);
    const long = await postFocus({ focus: "x".repeat(501) });
    expect(long.status).toBe(400);
  });
});
