import { describe, it, expect } from "vitest";
import {
  buildRegressionPrompt,
  REGRESSION_SYSTEM,
  stripCodeFences,
} from "../src/index";

const CTX = {
  repoName: "kaiser1x/ts-js-dummy",
  stats: { functions: 23, classes: 1, endpoints: 3, tests: 2, relationships: 85 },
  functions: [
    { name: "createPayment", file: "src/payments.ts", line: 41 },
    { name: "getUser", file: "src/users.ts", line: 12 },
  ],
  focus: "duplicate idempotency keys are rejected",
};

describe("buildRegressionPrompt", () => {
  it("grounds the draft in real function paths and the target behavior", () => {
    const prompt = buildRegressionPrompt(CTX);
    expect(prompt).toContain("kaiser1x/ts-js-dummy");
    expect(prompt).toContain("createPayment (src/payments.ts:41)");
    expect(prompt).toContain("duplicate idempotency keys are rejected");
    expect(prompt).toContain("do not invent paths");
    expect(prompt).toContain("no markdown fences");
  });

  it("includes an additional instruction when given", () => {
    const prompt = buildRegressionPrompt({ ...CTX, instruction: "use concurrent sends" });
    expect(prompt).toContain("use concurrent sends");
  });
});

describe("stripCodeFences", () => {
  it("unwraps fenced output", () => {
    expect(stripCodeFences("```ts\nimport x from 'y';\n```")).toBe("import x from 'y';");
    expect(stripCodeFences("```\nhello\n```")).toBe("hello");
  });

  it("leaves plain output untouched", () => {
    expect(stripCodeFences("import x from 'y';")).toBe("import x from 'y';");
    expect(stripCodeFences("  spaced  ")).toBe("spaced");
  });

  it("exposes a code-only system prompt", () => {
    expect(REGRESSION_SYSTEM).toContain("Output only code");
  });
});
