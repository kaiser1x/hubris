import { describe, it, expect, beforeAll } from "vitest";
import { composeForgeFocus, investigateTwin, type InvestigationPlan } from "../src/investigate";
import { runInvestigationAgent, type ClarificationSelection } from "../src/investigate-agent";
import {
  analyzeFixtureTwin,
  persistedBuggyTwin,
  persistedHealthyTwin,
  savedDefectiveInvestigation,
  REPORT_CLEAN,
  type TwinInput,
} from "./helpers/ts-js-dummy";

// Contract-quality regressions exposed by the saved investigation of
// kaiser1x/ts-js-dummy @ hubris/buggy-idempotency (job 051683d2): the plan
// carried a generic "requested entity" Expected field, labeled a key-PRESENCE
// check as the duplicate guard, and reduced the error contract to a test
// substring. Replayed against the saved twin AND the real analyzer output.

const GENERIC_ENTITY_EXPECTED =
  "The requested entity must be the one affected by the existing operation; other matching entities must remain unchanged.";

const BUGGY = persistedBuggyTwin();
const HEALTHY = persistedHealthyTwin();
const SAVED = savedDefectiveInvestigation();
let ANALYZED: TwinInput;

beforeAll(async () => {
  ANALYZED = await analyzeFixtureTwin();
});

async function plan(report: string, twin: TwinInput, over: { selections?: ClarificationSelection[] } = {}) {
  const out = await runInvestigationAgent({
    llm: null,
    jobId: "job-1",
    repository: "kaiser1x/ts-js-dummy",
    report,
    ...twin,
    ...over,
  });
  return out;
}

async function readyPlan(report: string, twin: TwinInput): Promise<InvestigationPlan> {
  const out = await plan(report, twin);
  expect(out.state, out.deterministic.message).toBe("READY_FOR_REVIEW");
  if (out.deterministic.status !== "READY") throw new Error("expected READY");
  return out.deterministic.plan;
}

const TWINS: Array<[string, () => TwinInput]> = [
  ["saved persisted twin", () => BUGGY.twin],
  ["real analyzer output", () => ANALYZED],
];

describe("the saved defective investigation is the regression fixture", () => {
  it("documents the defects being fixed (so the fixture cannot silently rot)", () => {
    expect(SAVED.expectedBehavior).toBe(GENERIC_ENTITY_EXPECTED);
    expect(SAVED.repairContract.relevantCondition).toContain("selection predicate if (idempotencyKey !== undefined)");
    expect(SAVED.repairContract.existingErrorContract).toBe('Related tests require an error matching: "duplicate payment".');
  });

  it.each(TWINS)("replaying the saved report on the %s no longer produces them", async (_name, twin) => {
    const p = await readyPlan(SAVED.focus, twin());
    expect(p.expectedBehavior).not.toBe(GENERIC_ENTITY_EXPECTED);
    expect(p.repairContract.relevantCondition).not.toContain("selection predicate if (idempotencyKey !== undefined)");
    expect(p.repairContract.existingErrorContract).not.toBe(SAVED.repairContract.existingErrorContract);
  });
});

describe.each(TWINS)("concrete reported behavior → specific Expected field (%s)", (_name, twin) => {
  it("states the rejection, the asserted error, and the report's own expectation", async () => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    expect(p.expectedBehavior).not.toBe(GENERIC_ENTITY_EXPECTED);
    expect(p.expectedBehavior).toMatch(/rejected with an error/i);
    expect(p.expectedBehavior).toContain("to throw");
    expect(p.expectedBehavior).toContain("duplicate payment");
    expect(p.expectedBehavior).toContain("duplicate payment for key");
    // The report's own words survive (verbatim, without the label).
    expect(p.expectedBehavior).toMatch(/must not create another payment/i);
  });

  it("requiredOutcome does not call every throw a 'repeated request'", async () => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    expect(p.repairContract.requiredOutcome).toContain("toThrow(");
    expect(p.repairContract.requiredOutcome).not.toMatch(/^The repeated request/);
  });
});

describe.each(TWINS)("condition selection is honest (%s)", (_name, twin) => {
  it("does not present a key-presence check as the duplicate guard", async () => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    const c = p.repairContract;
    expect(c.conditionKind).toBe("presence-precondition");
    expect(c.relevantCondition).toMatch(/^Repository condition:/);
    expect(c.relevantCondition).toMatch(/none found|no existing check/i);
    expect(c.relevantCondition).toContain("idempotencyKey !== undefined");
    expect(c.relevantCondition).toMatch(/tests presence|not whether/i);
    expect(c.relevantCondition).not.toMatch(/selection predicate/);
  });

  it("anchors on the target's own write and names what a repeat must not reach", async () => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    const c = p.repairContract;
    expect(p.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(c.relevantOperation).toMatch(/^Repository operation:/);
    expect(c.relevantOperation).toContain("seenIdempotencyKeys.add(idempotencyKey)");
    expect(JSON.stringify(c)).not.toContain("TRAIL");
    // Representation of the actionable requirement: add the missing check before
    // the write, reject before the later effects, keep everything else.
    expect(c.minimalRepairDescription).toMatch(/add the missing/i);
    expect(c.minimalRepairDescription).toContain("seenIdempotencyKeys");
    expect(c.minimalRepairDescription).toContain("savePayment");
    expect(c.minimalRepairDescription).toMatch(/first-time|unrelated behavior/i);
    // Never claims a guard that is not in the source.
    expect(JSON.stringify(c)).not.toContain("seenIdempotencyKeys.has");
  });
});

describe.each(TWINS)("error contract keeps the user's requirement and its provenance (%s)", (_name, twin) => {
  it("separates the test's substring check from the report's required message", async () => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    const e = p.repairContract.existingErrorContract;
    // Test side: reported as a substring/pattern check, not the full message.
    expect(e).toMatch(/Related tests require an error matching: /);
    expect(e).toMatch(/not the full message/i);
    // User side: the stronger requirement is preserved exactly.
    expect(e).toContain('"duplicate payment for key"');
    expect(e).toMatch(/keep exactly/i);
    // Source side: no source throw exists on the buggy revision, and it says so.
    expect(e).toMatch(/No source throw with this text was found/i);
    expect(e).not.toMatch(/Existing source throws/);
    // The plan-level preserve list carries the same requirement.
    expect(p.repairContract.preserveBehavior.join("\n")).toContain("duplicate payment for key");
  });
});

describe("healthy revision (guard present) is described as it is", () => {
  it("names the real duplicate check as the condition and the existing throw as the message source", async () => {
    const p = await readyPlan(REPORT_CLEAN, HEALTHY.twin);
    const c = p.repairContract;
    expect(c.conditionKind).toBe("causal-guard");
    expect(c.relevantCondition).toContain("seenIdempotencyKeys.has(idempotencyKey)");
    expect(c.existingErrorContract).toMatch(/Existing source throws: .*duplicate payment for key/);
    expect(c.existingErrorContract).not.toMatch(/No source throw/);
  });
});

describe("insufficient evidence blocks instead of producing an ungrounded READY plan", () => {
  const twinWith = (sourceFacts: any[], functions: any[], testFacts: any[]): TwinInput => ({
    functions,
    tests: [{ file: "tests/q.test.ts", name: "q.test", path: "tests/q.test.ts" }],
    relationships: [],
    sourceFacts: [...sourceFacts, ...testFacts],
  });
  const fn = (name: string, line: number, endLine: number) => ({ name, path: "src/q.ts", line, endLine });
  const src = (line: number, text: string) => ({ path: "src/q.ts", line, kind: "source", text });
  const tst = (line: number, text: string) => ({ path: "tests/q.test.ts", line, kind: "test", text });
  const REPORT = "Submitting the same idempotency key twice is accepted. It should throw `duplicate submission` instead.";

  it("a throw is expected but the target has no write to anchor on", async () => {
    const out = await plan(
      REPORT,
      twinWith(
        [src(1, "export function submit(key: string) {"), src(2, "if (key !== undefined) {"), src(3, "audit(key);")],
        [fn("submit", 1, 5)],
        [
          tst(1, 'it("rejects duplicate submissions", () => {'),
          tst(2, 'submit("k"); expect(() => submit("k")).toThrow("duplicate submission");'),
        ]
      )
    );
    expect(out.state).not.toBe("READY_FOR_REVIEW");
    expect(out.deterministic.status).toBe("AMBIGUOUS");
  });

  it("the only write is unrelated to the report (no invented duplicate guard)", async () => {
    const out = await plan(
      REPORT,
      twinWith(
        [
          src(1, "export function submit(key: string) {"),
          src(2, "if (key !== undefined) {"),
          src(3, "LEDGER.push(entry);"),
          src(4, "}"),
        ],
        [fn("submit", 1, 5)],
        [
          tst(1, 'it("rejects duplicate submissions", () => {'),
          tst(2, 'submit("k"); expect(() => submit("k")).toThrow("duplicate submission");'),
        ]
      )
    );
    expect(out.state).not.toBe("READY_FOR_REVIEW");
    expect(out.deterministic.status).toBe("AMBIGUOUS");
    expect(out.deterministic.plan).toBeNull();
  });

  it("the pure deterministic investigator blocks the same unrelated-write case", () => {
    const r = investigateTwin({
      focus: REPORT,
      ...twinWith(
        [
          src(1, "export function submit(key: string) {"),
          src(2, "if (key !== undefined) {"),
          src(3, "LEDGER.push(entry);"),
          src(4, "}"),
        ],
        [fn("submit", 1, 5)],
        [
          tst(1, 'it("rejects duplicate submissions", () => {'),
          tst(2, 'submit("k"); expect(() => submit("k")).toThrow("duplicate submission");'),
        ]
      ),
    });
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });

  it("a related write with a presence-only guard IS grounded (same shape, relevant write)", async () => {
    const out = await plan(
      REPORT,
      twinWith(
        [
          src(1, "export function submit(key: string) {"),
          src(2, "if (key !== undefined) {"),
          src(3, "seenKeys.add(key);"),
          src(4, "}"),
        ],
        [fn("submit", 1, 5)],
        [
          tst(1, 'it("rejects duplicate submissions", () => {'),
          tst(2, 'submit("k"); expect(() => submit("k")).toThrow("duplicate submission");'),
        ]
      )
    );
    expect(out.state).toBe("READY_FOR_REVIEW");
    if (out.deterministic.status === "READY") {
      expect(out.deterministic.plan.repairContract.conditionKind).toBe("presence-precondition");
    }
  });
});

describe("the condition is the guard that governs the asserted throw", () => {
  it("a rejecting check that sits AFTER the write is still found (not the presence guard before it)", async () => {
    const twin: TwinInput = {
      functions: [{ name: "submit", path: "src/q.ts", line: 1, endLine: 8 }],
      tests: [{ file: "tests/q.test.ts", name: "q.test", path: "tests/q.test.ts" }],
      relationships: [],
      sourceFacts: [
        { path: "src/q.ts", line: 1, kind: "source", text: "export function submit(key: string) {" },
        { path: "src/q.ts", line: 2, kind: "source", text: "if (key !== undefined) {" },
        { path: "src/q.ts", line: 3, kind: "source", text: "seenKeys.add(key);" },
        { path: "src/q.ts", line: 5, kind: "source", text: "if (alreadySeen(key)) {" },
        { path: "src/q.ts", line: 6, kind: "source", text: 'throw new Error("duplicate submission");' },
        { path: "tests/q.test.ts", line: 1, kind: "test", text: 'it("rejects duplicate submissions", () => {' },
        { path: "tests/q.test.ts", line: 2, kind: "test", text: 'submit("k"); expect(() => submit("k")).toThrow("duplicate submission");' },
      ],
    };
    const p = await readyPlan("Submitting the same idempotency key twice is accepted. It should throw `duplicate submission` instead.", twin);
    expect(p.repairContract.conditionKind).toBe("causal-guard");
    expect(p.repairContract.relevantCondition).toContain("alreadySeen(key)");
    expect(p.repairContract.relevantCondition).not.toContain("key !== undefined");
    expect(p.repairContract.existingErrorContract).toMatch(/Existing source throws: .*duplicate submission/);
  });
});

describe("clarification answers survive contract construction", () => {
  it("the pinned scenario drives the contract's assertion, error contract and reproduction", async () => {
    const vague = "Something is wrong with duplicate requests.";
    const asked = await plan(vague, ANALYZED);
    expect(asked.state).toBe("CLARIFICATION_NEEDED");
    const chosen = asked.clarification!.options.find((o) => o.scenario === "rejects a previously seen idempotency key")!;
    expect(chosen).toBeDefined();
    const answered = await plan(vague, ANALYZED, {
      selections: [{ questionId: asked.clarification!.questionId, optionId: chosen.id, option: chosen }],
    });
    expect(answered.clarification).toBeNull();
    expect(answered.selections[0].optionId).toBe(chosen.id);
    if (answered.deterministic.status !== "READY") throw new Error(answered.deterministic.message);
    const p = answered.deterministic.plan;
    expect(p.reproduction).toEqual({
      scenario: "rejects a previously seen idempotency key",
      testFile: "tests/idempotency-regression.test.ts",
    });
    // The pinned scenario's assertion (a regex), not the sibling's string.
    expect(p.repairContract.requiredOutcome).toContain("toThrow(/duplicate/i)");
    expect(p.repairContract.existingErrorContract).toContain("/duplicate/i");
    expect(p.repairContract.existingErrorContract).not.toContain('"duplicate payment"');
    expect(p.expectedBehavior).toContain("to throw /duplicate/i");
    expect(p.expectedBehavior).not.toBe(GENERIC_ENTITY_EXPECTED);
    expect(p.repairContract.conditionKind).toBe("presence-precondition");
  });
});

describe("the contract still fits the Forge focus budget", () => {
  it.each(TWINS)("composeForgeFocus keeps the whole contract and the constraints un-truncated (%s)", async (_name, twin) => {
    const p = await readyPlan(REPORT_CLEAN, twin());
    const focus = composeForgeFocus(p);
    expect(focus.length).toBeLessThanOrEqual(2000);
    // Everything unique to the contract survives; only the evidence-chain
    // repetition (which restates the contract's own facts) may be cut.
    expect(focus).toContain("Minimal repair: Add the missing check");
    expect(focus).toContain("duplicate payment for key");
    for (const c of p.constraints) expect(focus).toContain(c);
    expect(focus.indexOf("Constraints:")).toBeLessThan(focus.indexOf("Evidence chain:") === -1 ? Infinity : focus.indexOf("Evidence chain:"));
  });
});

describe("unchanged behavior elsewhere", () => {
  it("the pure deterministic investigator also yields the specific Expected field", () => {
    const r = investigateTwin({ focus: REPORT_CLEAN, ...BUGGY.twin });
    expect(r.status).toBe("READY");
    if (r.status === "READY") expect(r.plan.expectedBehavior).not.toBe(GENERIC_ENTITY_EXPECTED);
  });
});
