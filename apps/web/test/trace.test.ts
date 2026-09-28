import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import {
  traceFromTwin,
  type LiveEndpoint,
  type LiveJob,
} from "../app/lib/live-twin";

// Same deterministic fixture as the analyzer suite. The twin is built by the
// REAL analyzer (no mocks of the logic under test); ids are random per run,
// so assertions only use names, labels, and order.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/deep-chain", import.meta.url));

const ENTRY: LiveEndpoint = { method: "GET", path: "/start", file: "" };

async function fixtureJob(): Promise<LiveJob> {
  const twin = await analyzeRepository(FIXTURE);
  return {
    id: "test-job",
    repoUrl: "test/deep-chain",
    status: "complete",
    result: {
      jobId: "test-job",
      repository: { id: "r", name: "test/deep-chain", analysisStatus: "complete" },
      stats: {
        packages: twin.packages.length,
        functions: twin.functions.length,
        classes: twin.classes.length,
        endpoints: twin.endpoints.length,
        tests: twin.tests.length,
        relationships: twin.relationships.length,
        analysisMs: 0,
      },
      sample: { functions: [], endpoints: [] },
      full: {
        functions: twin.functions,
        classes: twin.classes,
        endpoints: twin.endpoints,
        tests: twin.tests,
        relationships: twin.relationships,
      },
    },
    error: null,
  };
}

function labels(steps: { label: string }[]): string[] {
  return steps.map((s) => s.label);
}

describe("GET /start execution path", () => {
  it("returns the expected exact sequence", async () => {
    const steps = traceFromTwin(await fixtureJob(), 8, ENTRY);
    expect(labels(steps)).toEqual([
      "GET /start",
      "begin",
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
  });

  it("contains exactly 8 steps (cap respected)", async () => {
    const job = await fixtureJob();
    expect(traceFromTwin(job, 8, ENTRY)).toHaveLength(8);
    expect(traceFromTwin(job, 3, ENTRY)).toHaveLength(3);
  });

  it("does not repeat charlie when the graph contains a cycle", async () => {
    const steps = traceFromTwin(await fixtureJob(), 8, ENTRY);
    expect(labels(steps).filter((l) => l === "charlie")).toHaveLength(1);
  });

  it("excludes external runtime calls from execution steps", async () => {
    const steps = traceFromTwin(await fixtureJob(), 8, ENTRY);
    const text = steps.map((s) => `${s.label} ${s.func} ${s.detail}`).join("\n");
    expect(labels(steps)).not.toContain("require");
    expect(text).not.toMatch(/console\.log/);
    // Steps are resolved definitions, never raw dotted references.
    expect(labels(steps).every((l) => !l.includes("."))).toBe(true);
  });

  it("does not traverse isolated decoy nodes", async () => {
    const steps = traceFromTwin(await fixtureJob(), 8, ENTRY);
    expect(labels(steps)).not.toContain("side");
    expect(labels(steps)).not.toContain("lonely");
  });

  it("defaults to the richest entry endpoint", async () => {
    const steps = traceFromTwin(await fixtureJob());
    expect(steps[0]?.label).toBe("GET /start");
  });
});

// Branch/order rule, documented where it is implemented (traceFromTwin):
// when a function calls several twin-defined functions, the FIRST one in
// edge-recording (source) order wins. zulu is absent from the fixture trace
// because echo precedes it in delta's body — not because zulu is special.
describe("branch/order rule", () => {
  function branchJob(): LiveJob {
    const functions = [
      { id: "f", name: "f", path: "a.js", line: 1, column: 1 },
      { id: "g", name: "g", path: "a.js", line: 5, column: 1 },
      { id: "z", name: "z", path: "a.js", line: 9, column: 1 },
    ];
    return {
      id: "branch",
      repoUrl: "test/branch",
      status: "complete",
      result: {
        jobId: "branch",
        repository: { id: "r", name: "test/branch", analysisStatus: "complete" },
        stats: { packages: 0, functions: 3, classes: 0, endpoints: 1, tests: 0, relationships: 2, analysisMs: 0 },
        sample: { functions: [], endpoints: [] },
        full: {
          functions,
          classes: [],
          endpoints: [{ path: "/go", method: "GET", file: "a.js" }],
          tests: [],
          relationships: [
            { from: "a.js", to: "f", type: "CALLS", caller: "endpoint:GET:/go" },
            { from: "a.js", to: "g", type: "CALLS", caller: "f" },
            { from: "a.js", to: "z", type: "CALLS", caller: "f" },
          ],
        },
      },
      error: null,
    };
  }

  it("first twin-defined callee in edge order wins", () => {
    const steps = traceFromTwin(branchJob(), 8, { method: "GET", path: "/go", file: "" });
    expect(labels(steps)).toEqual(["GET /go", "f", "g"]);
    expect(labels(steps)).not.toContain("z");
  });
});

describe("HTTP entry-point contract", () => {
  it("keeps an endpoint-free service repository empty", async () => {
    const job = await fixtureJob();
    job.result!.full!.endpoints = [];
    expect(traceFromTwin(job)).toEqual([]);
  });
});
