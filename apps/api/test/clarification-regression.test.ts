import { describe, it, expect, beforeAll } from "vitest";
import { investigateTwin } from "../src/investigate";
import { runInvestigationAgent } from "../src/investigate-agent";
import {
  analyzeFixtureTwin,
  persistedHealthyTwin,
  REPORT_CLEAN,
  REPORT_WITH_INSTRUCTIONS,
  type TwinInput,
} from "./helpers/ts-js-dummy";

// Root-cause regressions for the investigation clarification loop, replayed
// against the REAL persisted CodeTwin and the real analyzer output for the
// controlled kaiser1x/ts-js-dummy scenario (duplicate idempotency key).

let BUGGY: TwinInput;
const HEALTHY = persistedHealthyTwin();

beforeAll(async () => {
  BUGGY = await analyzeFixtureTwin();
});

function agent(report: string, twin: TwinInput) {
  return runInvestigationAgent({
    llm: null,
    jobId: "job-1",
    repository: "kaiser1x/ts-js-dummy",
    ref: null,
    commitSha: HEALTHY.commitSha,
    report,
    ...twin,
  });
}

describe("root cause A: current-vs-expected is not a contradiction", () => {
  it("a report with 'instead of' + investigation instructions is not contradictory", () => {
    const r = investigateTwin({ focus: REPORT_WITH_INSTRUCTIONS, ...HEALTHY.twin });
    expect(r.message).not.toMatch(/contradictory/i);
    expect(r.status).toBe("READY");
    if (r.status === "READY") expect(r.plan.target.function).toBe("createPayment");
  });

  it("the agent path also reaches a grounded contract for the same report", async () => {
    const out = await agent(REPORT_WITH_INSTRUCTIONS, HEALTHY.twin);
    expect(out.deterministic.message).not.toMatch(/contradictory/i);
    expect(out.state).toBe("READY_FOR_REVIEW");
    expect(out.clarification).toBeNull();
  });

  it("a genuinely self-contradictory expectation is still flagged", () => {
    const r = investigateTwin({
      focus: "The retry should create another payment and also reject the retry.",
      ...HEALTHY.twin,
    });
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.message.toLowerCase()).toContain("contradictory");
  });

  it("'accept the first request and reject the repeat' is sequencing, not a contradiction", () => {
    const r = investigateTwin({
      focus:
        "createPayment should accept the first request with a key and reject the second request that reuses the same idempotency key.",
      ...HEALTHY.twin,
    });
    expect(r.message.toLowerCase()).not.toContain("contradictory");
  });
});

describe("root cause B: causal operation comes from the target, not a lower-numbered callee line", () => {
  it("selects the target's own idempotency operation, never auditLog's TRAIL.push", async () => {
    const out = await agent(REPORT_CLEAN, HEALTHY.twin);
    expect(out.state, out.deterministic.message).toBe("READY_FOR_REVIEW");
    expect(out.deterministic.status).toBe("READY");
    if (out.deterministic.status !== "READY") return;
    const c = out.deterministic.plan.repairContract;
    expect(out.deterministic.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(c.relevantOperation).toContain("seenIdempotencyKeys.add");
    expect(c.relevantOperation).not.toContain("TRAIL");
    expect(c.relevantCondition).toContain("seenIdempotencyKeys.has");
    expect(c.sourceEvidence.join("\n")).not.toContain("TRAIL");
    expect(c.requiredOutcome).toContain("duplicate payment");
    expect(c.existingErrorContract).toContain("duplicate payment");
  });

  it("on the buggy revision (guard dropped) the contract anchors on the key record + its enclosing condition", async () => {
    const out = await agent(REPORT_CLEAN, BUGGY);
    expect(out.state, out.deterministic.message).toBe("READY_FOR_REVIEW");
    if (out.deterministic.status !== "READY") throw new Error("expected READY");
    const c = out.deterministic.plan.repairContract;
    expect(out.deterministic.plan.target.function).toBe("createPayment");
    expect(c.relevantOperation).toContain("seenIdempotencyKeys.add");
    expect(c.relevantCondition).toContain("idempotencyKey !== undefined");
    expect(c.sourceEvidence.join("\n")).not.toContain("TRAIL");
    // Test expectations stay distinguishable from the report text.
    expect(c.relevantAssertions.join("\n")).toContain("toThrow");
  });

  it("the agent path agrees with the pure deterministic investigator on the target", async () => {
    const det = investigateTwin({ focus: REPORT_CLEAN, ...BUGGY });
    const out = await agent(REPORT_CLEAN, BUGGY);
    expect(det.status).toBe("READY");
    if (det.status === "READY" && out.deterministic.status === "READY") {
      expect(out.deterministic.plan.target).toEqual(det.plan.target);
    }
  });
});
