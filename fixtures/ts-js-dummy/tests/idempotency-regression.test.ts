import { describe, expect, it } from "vitest";
import { createPayment } from "../src/payments.js";

// Controlled regression test for the hubris/buggy-idempotency fixture.
// Reported behavior: a request that reuses an already-used idempotency key is
// accepted instead of rejected with "Duplicate idempotency key". Currently FAILS (bug: keys are recorded but
// never checked).
describe("idempotency regression (buggy fixture)", () => {
  it("rejects a previously seen idempotency key", () => {
    createPayment("u-1", 100, "regression-k1");
    // Case-insensitive: any duplicate rejection satisfies the contract,
    expect(() => createPayment("u-1", 100, "regression-k1")).toThrow(/duplicate/i);
  });
});
