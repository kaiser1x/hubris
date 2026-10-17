import { describe, it, expect } from "vitest";
import { buildMismatchFeedback, describeSourceMismatch } from "../src/mismatch";

// The production failure (demo, 2026-10-17): the model double-escaped the line
// breaks in its JSON, so the decoded oldText held the two characters
// backslash + n where the analyzed source (256e395) has a real newline.
const SOURCE = [
  "export function createPayment(",
  "  userId: string,",
  "  amountCents: number,",
  "  idempotencyKey?: string",
  "): { payment: Payment; notice: string } {",
  "  const user = getUser(userId);",
  "  validatePayment(amountCents);",
  "  if (idempotencyKey !== undefined) {",
  "    seenIdempotencyKeys.add(idempotencyKey);",
  "  }",
  "  const payment = savePayment(user.id, amountCents);",
  "",
].join("\n");
const LITERAL_BACKSLASH_N = String.fromCharCode(92) + "n";
const MODEL_OLD_TEXT = [
  "  if (idempotencyKey !== undefined) {",
  "    seenIdempotencyKeys.add(idempotencyKey);",
  "  }",
].join(LITERAL_BACKSLASH_N);
const EXACT = "  if (idempotencyKey !== undefined) {\n    seenIdempotencyKeys.add(idempotencyKey);\n  }";

describe("redraft feedback after a byte-exact mismatch", () => {
  it("reproduces the production diagnostic: 37 characters matched (2 spaces + the if line)", () => {
    expect(describeSourceMismatch(SOURCE, MODEL_OLD_TEXT).matchingPrefixChars).toBe(37);
  });

  it("names a double-escaped line break as the cause", () => {
    const feedback = buildMismatchFeedback("src/payments.ts", MODEL_OLD_TEXT, SOURCE);
    expect(feedback).toContain("only its first 37 characters match");
    expect(feedback).toContain("contains a literal backslash followed by n where the source has a line break");
  });

  it("does not claim a double escape for other mismatches (e.g. wrong indentation)", () => {
    const misindented = "if (idempotencyKey !== undefined) {\n seenIdempotencyKeys.add(idempotencyKey);\n }";
    const feedback = buildMismatchFeedback("src/payments.ts", misindented, SOURCE);
    expect(feedback).not.toContain("literal backslash");
    expect(feedback).toContain("Whitespace and indentation count");
  });

  it("shows the exact lines, indentation included, as a JSON string; copying them matches exactly once", () => {
    const feedback = buildMismatchFeedback("src/payments.ts", MODEL_OLD_TEXT, SOURCE);
    expect(feedback).toContain(JSON.stringify(`${EXACT}\n  const payment = savePayment(user.id, amountCents);\n`));
    expect(SOURCE.split(EXACT).length - 1).toBe(1);
  });

  it("is bounded and falls back gracefully when nothing matches", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const feedback = buildMismatchFeedback("src/x.ts", Array.from({ length: 100 }, () => "line 0").join("\n"), long);
    const shown = JSON.parse(feedback.split("\n").find((l) => l.startsWith('"'))!) as string;
    expect(shown.split("\n").length).toBeLessThanOrEqual(40);
    expect(buildMismatchFeedback("src/x.ts", "zzz", "abc")).toContain("Copy oldText verbatim from the source excerpts above.");
  });
});
