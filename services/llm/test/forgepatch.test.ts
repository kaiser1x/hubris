import { describe, it, expect } from "vitest";
import { extractForgePatch } from "../src/index";

const DIFF = `diff --git a/src/users.ts b/src/users.ts
--- a/src/users.ts
+++ b/src/users.ts
@@ -1,3 +1,4 @@
+// probe
 export interface User {
   id: string;
   name: string;`;

describe("extractForgePatch", () => {
  it("extracts a plain diff", () => {
    expect(extractForgePatch(DIFF)).toBe(DIFF);
  });

  it("unwraps a fully fenced response", () => {
    expect(extractForgePatch("```diff\n" + DIFF + "\n```")).toBe(DIFF);
  });

  it("skips inline fences and cuts trailing sections", () => {
    const suggestion = [
      "1) PATCH",
      "```diff",
      DIFF,
      "```",
      "2) TEST",
      "vitest run passes",
      "3) WHY",
      "Two sentences.",
    ].join("\n");
    expect(extractForgePatch(suggestion)).toBe(DIFF);
  });

  it("cuts a trailing WHY section without headers", () => {
    const suggestion = DIFF + "\nWHY\nThis fixes the bug for good.";
    expect(extractForgePatch(suggestion)).toBe(DIFF);
  });

  it.each([
    "",
    "just prose, no patch here",
    "PATCH\nsorry, no diff today",
    "```\nno diff inside\n```",
    "diff --git a/x b/x\n(no hunks)",
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n(no hunk headers)",
  ])("returns null for malformed input: %s", (s) => {
    expect(extractForgePatch(s)).toBeNull();
  });

  // The exact failure shape diagnosed live (Phase I): hunk-only PATCH with
  // the file path supplied in prose. Must stay rejected — the parser never
  // infers paths from sentences.
  it("rejects the diagnosed hunk-only shape with path in prose", () => {
    const diagnosed = [
      "**PATCH**",
      "```diff",
      "@@",
      "-    seenIdempotencyKeys.add(idempotencyKey);",
      "+    if (seenIdempotencyKeys.has(idempotencyKey)) {",
      "+      throw new Error('Duplicate idempotency key');",
      "+    }",
      "+    seenIdempotencyKeys.add(idempotencyKey);",
      "```",
      "*Location: `src/payments.ts` inside the function that processes a payment.*",
    ].join("\n");
    expect(extractForgePatch(diagnosed)).toBeNull();
  });

  // Contract split, proven deterministically: the parser accepts
  // structurally-shaped diffs (headers + @@ present) while git remains the
  // final arbiter for hunk-count consistency. The parser never repairs.
  it("parser accepts shape but git rejects wrong hunk counts", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const exec = promisify(execFile);
    // Claims 1 old line but carries 1 removal + 1 context = 2.
    const wrongCounts = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      "-export const x = 1;",
      " export const x = 1;",
      "+// probe",
      "",
    ].join("\n");
    expect(extractForgePatch(wrongCounts)).not.toBeNull();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-hunk-"));
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
      fs.writeFileSync(path.join(dir, "w.diff"), wrongCounts);
      await expect(
        exec("git", ["apply", "--check", "w.diff"], { cwd: dir })
      ).rejects.toThrow();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
