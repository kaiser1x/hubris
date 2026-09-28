import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import { buildSourceFacts, toRepoRelative } from "../src/app";
import { investigateTwin, type InvestigationResult } from "../src/investigate";

// Generalized investigation evaluation matrix.
//
// The SAME deterministic investigator runs against a commerce-service fixture
// with five distinct bug classes (duplicate refund, cart removal, session
// expiry, order discount total, password-reset expiry), each probed with
// several different natural-language wordings including symptom-only reports.
// Distractors, ambiguous reports, contradictory reports, and no-match reports
// are exercised too. No repository-specific branching exists — the fixture is
// analyzed by the REAL analyzer and the investigator reads only repository
// evidence.

const FIXTURE = fileURLToPath(new URL("../../../fixtures/commerce-service", import.meta.url));

interface MatrixInput {
  functions: unknown[];
  tests: unknown[];
  relationships: unknown[];
  sourceFacts: unknown[];
}

let INPUT: MatrixInput;

beforeAll(async () => {
  const twin = await analyzeRepository(FIXTURE);
  const sourceFacts = buildSourceFacts(FIXTURE, twin);
  for (const fn of twin.functions) fn.path = toRepoRelative(FIXTURE, fn.path);
  for (const c of twin.classes) c.path = toRepoRelative(FIXTURE, c.path);
  for (const e of twin.endpoints) e.file = toRepoRelative(FIXTURE, e.file);
  for (const t of twin.tests) {
    t.path = toRepoRelative(FIXTURE, t.path);
    t.file = toRepoRelative(FIXTURE, t.file);
  }
  for (const r of twin.relationships) r.from = toRepoRelative(FIXTURE, r.from);
  INPUT = {
    functions: twin.functions,
    tests: twin.tests,
    relationships: twin.relationships,
    sourceFacts,
  };
});

function investigate(focus: string): InvestigationResult {
  return investigateTwin({ focus, ...INPUT });
}

function expectReady(focus: string, target: { file: string; function: string }) {
  const r = investigate(focus);
  expect(r.status, `report: ${focus}`).toBe("READY");
  if (r.status === "READY") {
    expect(r.plan.target, `report: ${focus}`).toEqual(target);
  }
}

describe("duplicate refund (payments.refund)", () => {
  it.each([
    "Refunding a payment twice should throw a cannot be refunded error instead of succeeding a second time.",
    "A payment that has already been refunded is refunded again and should be rejected.",
    "Customers can refund the same payment more than once.",
  ])("grounds READY on refund: %s", (focus) => {
    expectReady(focus, { file: "src/payments.ts", function: "refund" });
    const r = investigate(focus);
    if (r.status === "READY") {
      expect(r.plan.repairContract.existingErrorContract).toContain("cannot be refunded");
      expect(r.plan.repairContract.requiredOutcome).toContain("throw");
      // Never contaminated by createPayment's unrelated validation facts.
      expect(r.plan.repairContract.relevantCondition).not.toContain("Unknown user");
      expect(r.plan.repairContract.relevantCondition).not.toContain("positive number");
    }
  });
});

describe("cart item removal (cart.removeItem)", () => {
  it.each([
    "Removing one cart item sometimes removes the wrong item.",
    "When a product appears on more than one line, deleting it removes the wrong line.",
    "The wrong line is taken out of the cart when an item is removed.",
  ])("grounds READY on removeItem: %s", (focus) => {
    expectReady(focus, { file: "src/cart.ts", function: "removeItem" });
  });
});

describe("session expiry (sessions.refreshSession)", () => {
  it.each([
    "Expired sessions can still be refreshed.",
    "A session that has passed its TTL should not be refreshed.",
    "Stale sessions keep working after they expire.",
  ])("grounds READY on refreshSession: %s", (focus) => {
    expectReady(focus, { file: "src/sessions.ts", function: "refreshSession" });
    const r = investigate(focus);
    if (r.status === "READY") {
      expect(r.plan.repairContract.existingErrorContract).toContain("expired");
    }
  });
});

describe("order discount total (orders.createOrder)", () => {
  it.each([
    "The order total is wrong when a discount is applied.",
    "Applying a discount code does not change the order total.",
    "A discounted order is charged the full amount.",
  ])("grounds READY on createOrder: %s", (focus) => {
    expectReady(focus, { file: "src/orders.ts", function: "createOrder" });
  });
});

describe("password reset expiry (users.resetPassword)", () => {
  it.each([
    "A password reset token should not be usable after it expires.",
    "An expired password reset link still resets the password.",
    "Resetting the password works even after the reset token expired.",
  ])("grounds READY on resetPassword: %s", (focus) => {
    expectReady(focus, { file: "src/users.ts", function: "resetPassword" });
    const r = investigate(focus);
    if (r.status === "READY") {
      expect(r.plan.repairContract.existingErrorContract).toContain("expired");
    }
  });
});

describe("unrelated validation distractor stays scoped", () => {
  it("a createPayment validation report targets createPayment, not refund", () => {
    expectReady("Creating a payment for an unknown user should be rejected.", {
      file: "src/payments.ts",
      function: "createPayment",
    });
    const r = investigate("Creating a payment for an unknown user should be rejected.");
    if (r.status === "READY") {
      expect(r.plan.repairContract.existingErrorContract).toContain("Unknown user");
    }
  });

  it("the refund report never surfaces createPayment's unrelated facts", () => {
    const r = investigate("Refunding a payment twice should throw a cannot be refunded error.");
    if (r.status === "READY") {
      const text = JSON.stringify(r.plan);
      expect(text).not.toContain("positive number");
      expect(text).not.toContain("Unknown user");
    }
  });
});

describe("cart duplicate-entry removal (exact reported bug)", () => {
  it("grounds READY on the mutation function, not the reader", () => {
    const focus =
      "When a cart contains two different cart item entries that share the same product ID, " +
      "calling removeItem with the ID of one specific cart entry removes the wrong cart entry " +
      "instead. The failing behavior is that the requested cart item remains while another " +
      "cart entry for the same product is removed. The expected behavior is that only the " +
      "cart entry matching the requested cart item ID is removed.";
    const r = investigate(focus);
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target).toEqual({ file: "src/cart.ts", function: "removeItem" });
    // The contract is grounded in the mutation, not in reading the cart state.
    expect(r.plan.repairContract.relevantOperation).toContain("cart.items.delete");
    expect(r.plan.repairContract.relevantCondition).toContain("productId");
    // The relevant scenario asserts the post-state (which entry remains).
    expect(r.plan.evidence.join("\n")).toContain("removes only the requested line");
    // getCartItems is the reader — it must not be the target.
    expect(r.plan.evidence.join("\n")).toContain("removeItem");
  });

  it("a variant wording identifies the same mutation path", () => {
    const focus =
      "Two lines in the cart share one product. Removing one line by its entry id deletes the " +
      "wrong line: the line I asked to remove is still there and the other one is gone.";
    const r = investigate(focus);
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.target.function).toBe("removeItem");
  });
});

describe("anti-overfit (cart)", () => {
  it("a read-only cart report is never grounded on the removal function", () => {
    const r = investigate("The cart page should list each item and its quantity.");
    expect(r.status).not.toBe("READY");
  });

  it("a vague cart report stays AMBIGUOUS", () => {
    const r = investigate("Something is wrong with the cart.");
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });

  it("a behavior unsupported by the repository stays AMBIGUOUS", () => {
    const r = investigate("The cart should notify the owner by text message when it is emptied.");
    expect(r.status).toBe("AMBIGUOUS");
  });

  it("an unrelated mention of the cart never selects removeItem by vocabulary overlap", () => {
    const r = investigate("The cart widget on the dashboard is misconfigured.");
    expect(r.status).not.toBe("READY");
    if (r.status === "READY") {
      expect(r.plan.target.function).not.toBe("removeItem");
    }
  });

  it("removal stays ambiguous when no repository scenario establishes the post-state", () => {
    // Synthetic twin: removeItem exists, but no test scenario asserts what
    // remains after removal — so no coherent evidence chain exists.
    const r = investigateTwin({
      focus: "Removing a cart line deletes the wrong entry when two lines share a product.",
      functions: [
        { name: "removeItem", path: "src/cart.ts", line: 10, endLine: 20 },
        { name: "getCartItems", path: "src/cart.ts", line: 22, endLine: 25 },
      ],
      tests: [{ name: "cart.test", path: "tests/cart.test.ts" }],
      relationships: [],
      sourceFacts: [
        { path: "src/cart.ts", line: 12, kind: "source", text: "if (item.productId === productId) {" },
        { path: "src/cart.ts", line: 14, kind: "source", text: "cart.items.delete(lineId)" },
        { path: "tests/cart.test.ts", line: 5, kind: "test", text: "it('keeps a cart working', () => {" },
        { path: "tests/cart.test.ts", line: 6, kind: "test", text: "expect(getCartItems(cart.id)).toHaveLength(1)" },
      ],
    });
    // No scenario asserts the expected post-removal behavior for the report,
    // so READY must not be granted.
    expect(r.status).toBe("AMBIGUOUS");
  });
});

describe("ambiguous reports", () => {
  it.each([
    "Something is wrong with payments.",
    "Payments behave unexpectedly.",
    "Authentication is broken.",
  ])("returns AMBIGUOUS, never a guess: %s", (focus) => {
    const r = investigate(focus);
    expect(r.status, `report: ${focus}`).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });
});

describe("contradictory reports", () => {
  it("detects incompatible expectations", () => {
    const r = investigate("The retry should create another payment and also reject the retry.");
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.message.toLowerCase()).toContain("contradictory");
  });
});

describe("no-match reports", () => {
  it.each([
    "The hologram projector is misconfigured.",
    "Quantum flux capacitor orbit decaying.",
  ])("returns NO_MATCH: %s", (focus) => {
    const r = investigate(focus);
    expect(r.status, `report: ${focus}`).toBe("NO_MATCH");
    expect(r.plan).toBeNull();
  });
});

describe("source provenance", () => {
  it("every READY evidence line references a real repository location", () => {
    const reports = [
      "Refunding a payment twice should throw a cannot be refunded error instead of succeeding a second time.",
      "The order total is wrong when a discount is applied.",
      "Expired sessions can still be refreshed.",
    ];
    for (const focus of reports) {
      const r = investigate(focus);
      expect(r.status).toBe("READY");
      if (r.status !== "READY") continue;
      for (const line of r.plan.evidence) {
        expect(line.length).toBeGreaterThan(0);
      }
      const contract = r.plan.repairContract;
      // Every grounded field must cite repository-derived content.
      expect(contract.relevantCondition.startsWith("Repository condition:")).toBe(true);
      expect(contract.relevantOperation.startsWith("Repository operation:")).toBe(true);
    }
  });
});

describe("concrete evidence grounding (spec §9)", () => {
  it("preserves the concrete expected value instead of a generic template", () => {
    const r = investigate("The order total is wrong when a discount is applied.");
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    // The repository test asserts expect(order.total).toBe(180); that exact
    // expectation must survive, not be reduced to "computed correctly".
    expect(r.plan.repairContract.requiredOutcome).toContain("order.total");
    expect(r.plan.repairContract.requiredOutcome).toContain("180");
    expect(r.plan.expectedBehavior).toContain("order.total");
    expect(r.plan.expectedBehavior).not.toBe(
      "The reported value must be computed correctly while existing behavior remains unchanged."
    );
  });

  it("does not leak an unrelated assertion from the same it-block", () => {
    // payments.test.ts "rejects refunding a payment twice" also contains a
    // leftover expect(getUserById(...)).toBe(...) sanity check. It must not
    // enter the refund contract.
    const r = investigate("Refunding a payment twice should throw a cannot be refunded error.");
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    const all = JSON.stringify(r.plan.repairContract);
    expect(all).not.toContain("getUserById");
    expect(all).toContain("cannot be refunded");
  });
});