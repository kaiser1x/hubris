import { describe, expect, it } from "vitest";
import { createPayment, savePayment, validatePayment } from "../src/payments.js";
import { sendNotification } from "../src/notifications.js";

describe("validatePayment", () => {
  it("accepts positive amounts", () => {
    expect(() => validatePayment(100)).not.toThrow();
  });

  it.each([0, -5, Number.NaN])("rejects %s", (amount) => {
    expect(() => validatePayment(amount)).toThrow("invalid amount");
  });
});

describe("createPayment", () => {
  it("creates a completed payment and notifies", () => {
    const { payment, notice } = createPayment("u-1", 2500);
    expect(payment.status).toBe("completed");
    expect(payment.amountCents).toBe(2500);
    expect(notice).toContain("ada@example.com");
    expect(notice).toContain("$25.00");
  });

  it("rejects unknown users", () => {
    expect(() => createPayment("ghost", 100)).toThrow("unknown user");
  });

  it("rejects duplicate idempotency keys", () => {
    createPayment("u-2", 100, "key-1");
    expect(() => createPayment("u-2", 100, "key-1")).toThrow("duplicate payment");
  });

  it("savePayment appends to the ledger", () => {
    const payment = savePayment("u-1", 50);
    expect(payment.id).toBeTruthy();
  });
});

describe("sendNotification", () => {
  it("formats the message", () => {
    const line = sendNotification({ id: "t", name: "T", email: "t@example.com" }, "hello");
    expect(line).toBe("[notify] t@example.com: hello");
  });
});
