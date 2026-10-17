import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisLimitError, analyzeRepository } from "../src/index";

// The analyzer runs inside the API server process. It must hand control back
// to the event loop while it works (so /health and other requests are served)
// and refuse oversized repositories before parsing them.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(files: number): string {
  const root = mkdtempSync(join(tmpdir(), "hubris-yield-"));
  dirs.push(root);
  for (let i = 0; i < files; i++) {
    const dir = join(root, "src", `m${i % 4}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `f${i}.ts`),
      `import { helper } from "./helper";\nexport function f${i}(a: number): number {\n  if (a > ${i}) throw new Error("x");\n  return helper(a);\n}\n`
    );
  }
  return root;
}

describe("analyzer responsiveness", () => {
  it("lets other work run while a repository is analyzed (does not hold the event loop)", async () => {
    const repo = makeRepo(40);
    let ticks = 0;
    let finished = false;
    const timer = setInterval(() => {
      if (!finished) ticks += 1;
    }, 0);
    const analysis = analyzeRepository(repo).then((twin) => {
      finished = true;
      return twin;
    });
    // A request arriving mid-analysis is served before the analysis ends.
    const served = await Promise.race([
      new Promise<"served">((resolve) => setTimeout(() => resolve("served"), 0)),
      analysis.then(() => "analysis-finished-first" as const),
    ]);
    const twin = await analysis;
    clearInterval(timer);
    expect(served).toBe("served");
    expect(ticks).toBeGreaterThan(0);
    expect(twin.functions).toHaveLength(40);
  });

  it("keeps results in file order and identical across runs", async () => {
    const repo = makeRepo(12);
    const a = await analyzeRepository(repo);
    const b = await analyzeRepository(repo);
    const shape = (t: Awaited<ReturnType<typeof analyzeRepository>>) => ({
      functions: t.functions.map((f) => `${f.path}:${f.name}:${f.line}`),
      relationships: t.relationships.map((r) => `${r.from}->${r.to}:${r.type}`),
    });
    expect(shape(a)).toEqual(shape(b));
    // Depth-first file order: m0 before m1 …, f0 before f4 within a folder.
    expect(a.functions.map((f) => f.name).slice(0, 3)).toEqual(["f0", "f4", "f8"]);
  });

  it("refuses a repository over the file limit before parsing it", async () => {
    const repo = makeRepo(6);
    await expect(analyzeRepository(repo, { maxFiles: 5 })).rejects.toBeInstanceOf(AnalysisLimitError);
    await expect(analyzeRepository(repo, { maxFiles: 5 })).rejects.toThrow(/more than 5 source files/);
    expect((await analyzeRepository(repo, { maxFiles: 6 })).functions).toHaveLength(6);
  });
});
