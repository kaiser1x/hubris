import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository, type Relationship } from "../src/index";

// Focused arrow-function fixture. No network, no DB.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/arrow-fns", import.meta.url));

function callsFrom(rels: Relationship[], caller: string): string[] {
  return rels.filter((r) => r.type === "CALLS" && r.caller === caller).map((r) => r.to);
}

describe("arrow functions", () => {
  it("1. discovers a basic arrow function", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(twin.functions.map((f) => f.name)).toContain("basic");
  });

  it("2. discovers an exported arrow function once", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(twin.functions.map((f) => f.name).filter((n) => n === "exported")).toHaveLength(1);
  });

  it("3. discovers an async arrow function", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(twin.functions.map((f) => f.name)).toContain("exported");
    expect(callsFrom(twin.relationships, "exported")).toContain("findOne");
  });

  it("4. attributes calls inside the arrow body", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(callsFrom(twin.relationships, "basic")).toEqual(["helper"]);
  });

  it("5. qualifies nested arrows without double nodes", async () => {
    const twin = await analyzeRepository(FIXTURE);
    const names = twin.functions.map((f) => f.name);
    expect(names).toContain("outer.inner");
    expect(names).not.toContain("inner");
    expect(names.filter((n) => n === "outer")).toHaveLength(1);
  });

  it("6. attributes route-handler arrows to the endpoint scope, not a node", async () => {
    const twin = await analyzeRepository(FIXTURE);
    const names = twin.functions.map((f) => f.name);
    expect(names.some((n) => n.startsWith("endpoint:"))).toBe(false);
    expect(callsFrom(twin.relationships, "endpoint:GET:/ping")).toEqual(["pong"]);
  });

  it("7. records a named function calling an arrow", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(callsFrom(twin.relationships, "caller")).toEqual(["basic"]);
  });

  it("8. records an arrow calling a named function", async () => {
    const twin = await analyzeRepository(FIXTURE);
    expect(callsFrom(twin.relationships, "outer.inner")).toEqual(["target"]);
  });
});
