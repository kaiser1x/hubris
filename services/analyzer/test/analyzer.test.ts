import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository, type Relationship } from "../src/index";

// Deterministic fixture: routes + controllers + a deep helper chain with
// branches, a cycle, externals, and a decoy endpoint. No network, no DB.
// Resolved from the test file location so CWD never matters.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/deep-chain", import.meta.url));

function calls(rels: Relationship[], caller: string): string[] {
  return rels.filter((r) => r.type === "CALLS" && r.caller === caller).map((r) => r.to);
}

describe("deep-chain fixture extraction", () => {
  it("discovers endpoints and functions", async () => {
    const twin = await analyzeRepository(FIXTURE);
    const routes = twin.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(routes).toContain("GET /start");
    expect(routes).toContain("GET /other");
    const names = twin.functions.map((f) => f.name);
    for (const n of ["begin", "side", "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "zulu", "lonely"]) {
      expect(names).toContain(n);
    }
  });

  it("links the route registration to its handler reference", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(
      twin.relationships.some(
        (r) => r.type === "CALLS" && r.caller === "endpoint:GET:/start" && r.to === "controller.begin"
      )
    ).toBe(true);
  });

  it("records the exact delta branch set", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(new Set(calls(twin.relationships, "delta"))).toEqual(new Set(["require", "echo", "zulu"]));
  });

  it("records the foxtrot cycle edge without looping", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(new Set(calls(twin.relationships, "foxtrot"))).toEqual(new Set(["golf", "charlie"]));
  });

  it("attributes begin to its own calls, not the whole file", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(calls(twin.relationships, "begin")).toEqual(["chain.alpha"]);
  });

  it("excludes console noise at the extraction layer", async () => {
    const twin = await analyzeRepository(FIXTURE);
    const targets = twin.relationships.map((r) => r.to);
    expect(targets.some((t) => t.startsWith("console"))).toBe(false);
  });

  it("does not record route registrations as calls", async () => {
    const twin = await analyzeRepository(FIXTURE);
    const targets = twin.relationships.filter((r) => r.type === "CALLS").map((r) => r.to);
    expect(targets).not.toContain("router.get");
    expect(targets).not.toContain("router.post");
  });
});
