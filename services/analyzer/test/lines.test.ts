import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "../src/index";

// Real source locations: line numbers must come from the parser's position
// data, never a hardcoded 1. Fixtures put functions on clearly distinct
// lines so every assertion is exact.
const DEEP = fileURLToPath(new URL("../../../fixtures/deep-chain", import.meta.url));
const ARROWS = fileURLToPath(new URL("../../../fixtures/arrow-fns", import.meta.url));

function byName(fns: { name: string; line: number; column: number }[], name: string) {
  const fn = fns.find((f) => f.name === name);
  expect(fn, `expected function ${name}`).toBeDefined();
  return fn!;
}

describe("real function line numbers", () => {
  it("declarations point to their actual source lines", async () => {
    const twin = await analyzeRepository(DEEP);
    const chain = twin.functions.filter((f) => f.path.endsWith("chain.js"));
    expect(byName(chain, "alpha").line).toBe(1);
    expect(byName(chain, "bravo").line).toBe(6);
    expect(byName(chain, "charlie").line).toBe(10);
    expect(byName(chain, "delta").line).toBe(14);
    expect(byName(chain, "zulu").line).toBe(44);
  });

  it("multiple functions in one file have distinct locations", async () => {
    const twin = await analyzeRepository(DEEP);
    const chain = twin.functions.filter((f) => f.path.endsWith("chain.js"));
    const lines = chain.map((f) => f.line);
    expect(new Set(lines).size).toBe(lines.length);
    for (const fn of chain) {
      expect(fn.line).toBeGreaterThan(0);
      expect(fn.column).toBeGreaterThan(0);
    }
  });

  it("Express-style handlers resolve to the exported name's line", async () => {
    const twin = await analyzeRepository(DEEP);
    const controller = twin.functions.filter((f) => f.path.endsWith("controller.js"));
    expect(byName(controller, "begin").line).toBe(3);
    expect(byName(controller, "side").line).toBe(8);
  });
});

describe("real arrow-function line numbers", () => {
  it("arrows point to their variable declaration line", async () => {
    const twin = await analyzeRepository(ARROWS);
    expect(byName(twin.functions, "basic").line).toBe(1);
    expect(byName(twin.functions, "exported").line).toBe(5);
    expect(byName(twin.functions, "outer").line).toBe(14);
    // Nested arrow keeps its own declaration line, qualified by scope.
    expect(byName(twin.functions, "outer.inner").line).toBe(15);
  });

  it("named declarations and arrows in the same file stay distinct", async () => {
    const twin = await analyzeRepository(ARROWS);
    const lines = twin.functions.map((f) => f.line);
    expect(new Set(lines).size).toBe(lines.length);
  });
});