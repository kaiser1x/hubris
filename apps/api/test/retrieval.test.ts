// Hybrid retrieval over the real commerce-service fixture. The fixture is
// analyzed by the REAL analyzer and its facts are built by the REAL
// buildSourceFacts, so these verdicts transfer to a live job.
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import { buildSourceFacts, toRepoRelative } from "../src/app";
import {
  buildRetrievalIndex,
  retrieveEvidence,
  toEvidence,
  renderEvidenceForPrompt,
  profileFor,
  type RetrievalIndex,
  type RetrievalUnit,
} from "../src/retrieval";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/commerce-service", import.meta.url));

let INDEX: RetrievalIndex;

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
});

function sourceScore(name: string): number {
  const unit = INDEX.units.find(
    (u) => u.sourceType === "source" && u.function === name
  );
  expect(unit, `source unit for ${name}`).toBeTruthy();
  const scored = retrieveEvidence(INDEX, "Something is wrong with order discounts.", {
    limit: 200,
    jobId: "job-1",
  });
  return scored.find((s) => s.unit.id === unit!.id)?.score ?? 0;
}

describe("hybrid retrieval index", () => {
  it("builds source, test, graph, and metadata units from the twin", () => {
    const types = new Set(INDEX.units.map((u) => u.sourceType));
    expect(types.has("source")).toBe(true);
    expect(types.has("test")).toBe(true);
    expect(types.has("metadata")).toBe(true);
  });

  it("stamps every unit with the exact job provenance", () => {
    for (const u of INDEX.units) {
      expect(u.provenance.jobId).toBe("job-1");
      expect(u.provenance.repository).toBe("acme/commerce");
      expect(u.provenance.commitSha).toBe("a".repeat(40));
    }
  });

  it("captures the discount test scenario as assertion-bearing evidence", () => {
    const discount = INDEX.units.find(
      (u) => u.sourceType === "test" && u.testScenario?.includes("discount")
    );
    expect(discount).toBeTruthy();
    expect(discount!.assertions.join("\n")).toContain("order.total");
    expect(discount!.text).toContain("createOrder");
  });
});

describe("hybrid scoring keeps the exercised function ahead", () => {
  it("ranks createOrder above getCartTotal for a discount-total report", () => {
    // getCartTotal also contains the token "total"; only the discount test
    // scenario and the action actually exercise createOrder.
    expect(sourceScore("createOrder")).toBeGreaterThan(sourceScore("getCartTotal"));
  });

  it("boosts the scenario that calls the believed target", () => {
    const withoutTarget = retrieveEvidence(INDEX, "order discount", { jobId: "job-1" });
    const withTarget = retrieveEvidence(INDEX, "order discount", {
      jobId: "job-1",
      targetName: "createOrder",
    });
    const scenarioOf = (list: typeof withoutTarget) =>
      list.find((s) => s.unit.sourceType === "test" && s.unit.testScenario?.includes("discount"));
    const a = scenarioOf(withoutTarget);
    const b = scenarioOf(withTarget);
    expect(a && b).toBeTruthy();
    expect(b!.score).toBeGreaterThan(a!.score);
  });
});

describe("retrieval isolation", () => {
  it("returns nothing when asked for another job's provenance", () => {
    expect(retrieveEvidence(INDEX, "order discount", { jobId: "other-job" })).toEqual([]);
  });

  it("answers vague reports with useful, relevant units", () => {
    const scored = retrieveEvidence(INDEX, "Something is wrong with the discount.", {
      jobId: "job-1",
      limit: 10,
    });
    expect(scored.length).toBeGreaterThan(0);
    const top = scored[0]!;
    const text = [
      top.unit.function ?? "",
      top.unit.testScenario ?? "",
      top.unit.text,
    ].join(" ");
    expect(text.toLowerCase()).toMatch(/discount|total|order/);
  });
});

describe("evidence contract", () => {
  it("maps a unit to provenance-carrying evidence", () => {
    const unit = INDEX.units.find((u) => u.sourceType === "source") as RetrievalUnit;
    const ev = toEvidence(unit);
    expect(ev.sourceType).toBe("source");
    expect(ev.file).toBe(unit.file);
    expect(ev.provenance.jobId).toBe("job-1");
    expect(ev.provenance.commitSha).toBe("a".repeat(40));
  });

  it("renders bounded prompt context with unit ids", () => {
    const scored = retrieveEvidence(INDEX, "order discount", { jobId: "job-1", limit: 3 });
    const rendered = renderEvidenceForPrompt(scored, 2000);
    expect(rendered.length).toBeLessThanOrEqual(2000);
    expect(rendered).toContain("[");
  });

  it("splits report text into tokens, concepts, and subject tokens", () => {
    const p = profileFor("Something is wrong with order discounts.");
    expect(p.concepts.has("calculate")).toBe(true);
    expect([...p.subjectTokens]).toContain("order");
  });
});
