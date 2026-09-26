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
});
