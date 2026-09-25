import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepository } from "../src/index";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "hubris-walk-"));
  dirs.push(root);
  writeFileSync(join(root, "app.ts"), "export function app() {}\n");
  for (const skipped of ["node_modules", "dist", ".git"]) {
    const dir = join(root, skipped);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lib.js"), "export function lib() {}\n");
  }
  return root;
}

describe("directory exclusions", () => {
  it("never parses node_modules, dist, or .git", async () => {
    const twin = await analyzeRepository(makeTree());
    const names = twin.functions.map((f) => f.name);
    expect(names).toContain("app");
    expect(names).not.toContain("lib");
    expect(twin.functions).toHaveLength(1);
  });
});
