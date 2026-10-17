import { describe, it, expect } from "vitest";
import {
  buildStructuredPrompt,
  STRUCTURED_SYSTEM,
} from "../src/index";

const CTX = {
  repoName: "kaiser1x/ts-js-dummy",
  excerpts: [
    {
      path: "src/payments.ts",
      function: "createPayment",
      lines: "41-60",
      text: "export function createPayment(\n  userId: string,",
    },
  ],
  focus: "duplicate idempotency keys are rejected",
};

describe("buildStructuredPrompt", () => {
  it("grounds the plan in bounded excerpts with paths and line ranges", () => {
    const prompt = buildStructuredPrompt(CTX);
    expect(prompt).toContain("kaiser1x/ts-js-dummy");
    expect(prompt).toContain("duplicate idempotency keys are rejected");
    expect(prompt).toContain("--- src/payments.ts (createPayment, lines 41-60) ---");
    expect(prompt).toContain("userId: string,");
    expect(prompt).toContain("ONLY a JSON object");
    expect(prompt).toContain("EXACTLY (character for character)");
  });

  it("says how to encode line breaks in oldText/newText (production double-escape failure)", () => {
    const prompt = buildStructuredPrompt(CTX);
    const rule = prompt.split("\n").find((l) => l.startsWith("oldText and newText are JSON strings"));
    expect(rule).toBeDefined();
    const one = String.fromCharCode(92) + "n";
    const two = String.fromCharCode(92, 92) + "n";
    expect(rule).toContain(`encode each line break ONCE as ${one} (one backslash)`);
    expect(rule).toContain(`Never write ${two}`);
    expect(rule).toContain("real line breaks and the original indentation");
  });

  it("demands machine-readable output and exposes no secrets", () => {
    const prompt = buildStructuredPrompt(CTX);
    expect(prompt).toContain("no markdown, no prose, no fences");
    expect(prompt).not.toMatch(/NEBIUS_API_KEY|DATABASE_URL|GITHUB_TOKEN|Bearer /);
    expect(STRUCTURED_SYSTEM).toContain("Output only a JSON edit plan");
  });

  // Phase I minimal-patch contract: the model must fix the bug with the
  // smallest possible change and preserve observable behavior. A prior live
  // run proved the mechanics end-to-end but failed verification because the
  // draft replaced the existing "duplicate payment for key ..." error with
  // invented wording — a contract change, not a sandbox failure.
  it("requires the smallest possible change", () => {
    const prompt = buildStructuredPrompt(CTX);
    expect(prompt).toContain("smallest possible change required to fix the reported bug");
  });

  it("requires preserving existing error messages and observable behavior", () => {
    const prompt = buildStructuredPrompt(CTX);
    expect(prompt).toContain("Preserve all existing externally observable behavior");
    expect(prompt).toContain("Do not change existing error messages");
    expect(prompt).toContain("Reuse existing constants, strings, and behavior");
    expect(prompt).toContain("Do not invent replacement wording");
  });
});
