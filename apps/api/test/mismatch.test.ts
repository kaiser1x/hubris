import { describe, expect, it } from "vitest";
import { describeSourceMismatch } from "../src/mismatch";

describe("describeSourceMismatch", () => {
  const SOURCE = "export function refund(id) {\n  const p = get(id)\n  if (p.status !== 'succeeded') {\n    throw new Error('cannot refund')\n  }\n  return p\n}\n";

  it("reports a fully absent oldText (no character matches)", () => {
    const d = describeSourceMismatch(SOURCE, "missing();");
    expect(d.oldTextLength).toBe("missing();".length);
    expect(d.sourceLength).toBe(SOURCE.length);
    expect(d.matchingPrefixChars).toBe(0);
    expect(d.sourceOffset).toBe(-1);
  });

  it("reports how much of the oldText actually matches and where it diverges", () => {
    // oldText matches the source for its first N chars, then diverges.
    const oldText = "export function refund(id) {\n  const q = get(id)\n";
    const d = describeSourceMismatch(SOURCE, oldText);
    expect(d.oldTextLength).toBe(oldText.length);
    expect(d.matchingPrefixChars).toBeGreaterThan(20);
    expect(d.matchingPrefixChars).toBeLessThan(oldText.length);
    expect(d.sourceOffset).toBe(0);
    // The prefix "export function refund(id) {\n  const " is present; the
    // next char 'q' is not in the source at that point, so matching stops.
    expect(d.oldTextSnippet).toContain("export function refund");
  });

  it("reports a matching prefix at a non-zero source offset", () => {
    const d = describeSourceMismatch(SOURCE, "return p");
    expect(d.matchingPrefixChars).toBe("return p".length);
    expect(d.sourceOffset).toBeGreaterThan(0);
    expect(d.sourceSnippet).toContain("return p");
  });

  it("bound snippets: never the full file, CRLF stripped", () => {
    const d = describeSourceMismatch("a\r\nb\r\n" + "x".repeat(1000), "a\r\nb\r\n");
    expect(d.oldTextSnippet).not.toContain("\r");
    expect(d.sourceSnippet.length).toBeLessThanOrEqual(240);
    expect(d.oldTextLength).toBe("a\r\nb\r\n".length);
  });

  it("is total on malformed input", () => {
    expect(() => describeSourceMismatch(null as unknown as string, null as unknown as string)).not.toThrow();
    const d = describeSourceMismatch(null as unknown as string, null as unknown as string);
    expect(d.oldTextLength).toBe(0);
    expect(d.sourceLength).toBe(0);
  });
});