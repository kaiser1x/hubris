import { describe, it, expect } from "vitest";
import {
  buildRedraftPrompt,
  REDRAFT_ERROR_CHARS,
  REDRAFT_SYSTEM,
} from "../src/index";

describe("buildRedraftPrompt", () => {
  it("carries the task, bounded git error, and original diff — never secrets", () => {
    const prompt = buildRedraftPrompt({
      originalDiff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      gitError: "error: corrupt patch at line 7\n",
      focus: "duplicate keys rejected",
    });
    expect(prompt).toContain("Original task: duplicate keys rejected");
    expect(prompt).toContain("corrupt patch at line 7");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain("@@ line counts match");
    expect(prompt).toContain("Return a complete Git-applicable unified diff");
    expect(prompt).not.toMatch(/NEBIUS_API_KEY|DATABASE_URL|Bearer /);
  });

  it("bounds a hostile-length git error", () => {
    const prompt = buildRedraftPrompt({
      originalDiff: "diff --git a/x b/x\n",
      gitError: "e".repeat(5000),
    });
    const afterMarker = prompt.split("Git error:")[1];
    expect(afterMarker).not.toContain("e".repeat(REDRAFT_ERROR_CHARS + 1));
    expect(REDRAFT_ERROR_CHARS).toBeLessThanOrEqual(1500);
  });

  it("exposes a diff-only system prompt", () => {
    expect(REDRAFT_SYSTEM).toContain("Output only the complete unified diff");
  });
});
