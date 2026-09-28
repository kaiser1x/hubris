// Evidence-binding regression tests (architectural invariant).
//
// Proves that once a selection layer chooses repository evidence, the
// deterministic validator/extractor grounds the contract on THAT evidence —
// it never substitutes an unrelated guard or a persistence write, and it never
// invents a repair when the selected evidence has no causal operation.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import { buildSourceFacts, toRepoRelative } from "../src/app";
import {
  buildPlanFromEvidence,
  reconstructScenarios,
  type TestScenario,
  type TwinSourceFactInput,
} from "../src/investigate";

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return { ...actual, chatComplete: vi.fn() };
});
import { chatComplete, type LlmConfig } from "@hubris/llm";
import { runInvestigationAgent } from "../src/investigate-agent";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/commerce-service", import.meta.url));
const DISCOUNT_REPORT =
  "Some users are getting charged the full order amount even when they use a discount code. The discount seems to be accepted, but the final total doesn't actually go down.";
const CART_REPORT =
  "Removing one cart item sometimes removes the wrong item when two lines share the same product.";

// ---------------------------------------------------------------------------
// Synthetic twin mirroring a createOrder -> applyDiscount shape (the real
// repository structure), with a value computation, helper function, unrelated
// early guard, and a trailing persistence write.
// ---------------------------------------------------------------------------
const SYN_FUNCTIONS = [
  { name: "applyDiscount", path: "src/orders.ts", line: 42, endLine: 46 },
  { name: "createOrder", path: "src/orders.ts", line: 48, endLine: 77 },
];
const SYN_TESTS = [{ name: "orders.test", path: "tests/orders.test.ts", file: "tests/orders.test.ts" }];
const SYN_FACTS: TwinSourceFactInput[] = [
  { path: "src/orders.ts", line: 42, kind: "source", text: "export function applyDiscount(subtotal: number, discountCode: string | undefined): number {" },
  { path: "src/orders.ts", line: 43, kind: "source", text: "if (!discountCode) return subtotal" },
  { path: "src/orders.ts", line: 44, kind: "source", text: "if (discountCode === 'SAVE10') return Math.round(subtotal * 0.9)" },
  { path: "src/orders.ts", line: 45, kind: "source", text: "throw new Error(`Unknown discount code: ${discountCode}`)" },
  { path: "src/orders.ts", line: 48, kind: "source", text: "export function createOrder(userId: string, cartId: string, discountCode?: string): Order {" },
  { path: "src/orders.ts", line: 49, kind: "source", text: "const user = getUserByIdOrThrow(userId)" },
  { path: "src/orders.ts", line: 50, kind: "source", text: "const cart = getCart(cartId)" },
  { path: "src/orders.ts", line: 51, kind: "source", text: "if (!cart) throw new Error(`Unknown cart: ${cartId}`)" },
  { path: "src/orders.ts", line: 52, kind: "source", text: "if (cart.userId !== user.id) {" },
  { path: "src/orders.ts", line: 56, kind: "source", text: "const items = getCartItems(cartId)" },
  { path: "src/orders.ts", line: 57, kind: "source", text: "if (items.length === 0) throw new Error('Cannot place an order with an empty cart')" },
  { path: "src/orders.ts", line: 59, kind: "source", text: "const subtotal = getCartTotal(cartId)" },
  { path: "src/orders.ts", line: 60, kind: "source", text: "const total = applyDiscount(subtotal, discountCode)" },
  { path: "src/orders.ts", line: 61, kind: "source", text: "const payment = createPayment(user.id, total)" },
  { path: "src/orders.ts", line: 71, kind: "source", text: "store.orders.set(order.id, order)" },
  { path: "tests/orders.test.ts", line: 42, kind: "test", text: "it('applies a discount code to the order total', () => {" },
  { path: "tests/orders.test.ts", line: 47, kind: "test", text: "const order = createOrder(user.id, cart.id, 'SAVE10')" },
  { path: "tests/orders.test.ts", line: 48, kind: "test", text: "expect(order.total).toBe(1350)" },
];
const SYN_SCENARIOS = reconstructScenarios(SYN_FACTS, new Set(["tests/orders.test.ts"]));
const SYN_KNOWN = new Set(["applyDiscount", "createOrder", "getCartTotal", "getUserByIdOrThrow", "getCart", "getCartItems", "createPayment"]);

function syntheticPlan(scenarioIndex = 0) {
  return buildPlanFromEvidence({
    focus: DISCOUNT_REPORT,
    target: { name: "createOrder", path: "src/orders.ts", line: 48, endLine: 77 },
    scenarios: [SYN_SCENARIOS[scenarioIndex]],
    sourceFacts: SYN_FACTS,
    knownFunctions: SYN_KNOWN,
    functions: SYN_FUNCTIONS,
    selectedFunctionNames: new Set(["createOrder", "applyDiscount"]),
  });
}

describe("causal extraction from selected evidence (synthetic helper shape)", () => {
  it("keeps the selected helper (applyDiscount) in the authoritative chain and uses its branch", () => {
    const r = syntheticPlan();
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    const c = r.plan.repairContract;
    // Condition is the discount branch INSIDE the selected helper.
    expect(c.relevantCondition).toContain("discountCode === 'SAVE10'");
    expect(c.relevantCondition).not.toContain("items.length === 0");
    // The helper is part of the evidence chain.
    expect(c.sourceEvidence.join("\n")).toContain("applyDiscount");
  });

  it("selects the total computation, not the const-discarding persistence write", () => {
    const r = syntheticPlan();
    if (r.status !== "READY") throw new Error("expected READY");
    const c = r.plan.repairContract;
    expect(c.relevantOperation).toContain("total = applyDiscount(subtotal, discountCode)");
    expect(c.relevantOperation).not.toContain("store.orders.set");
    expect(c.requiredOutcome).toContain("toBe(1350)");
  });

  it("does not fall back to the empty-cart guard merely because it occurs earlier", () => {
    const r = syntheticPlan();
    if (r.status !== "READY") throw new Error("expected READY");
    expect(r.plan.repairContract.relevantCondition).not.toContain("empty cart");
    expect(r.plan.repairContract.sourceEvidence.join("\n")).not.toContain("empty cart");
  });

  it("returns AMBIGUOUS when the selected evidence cannot establish a causal operation", () => {
    const facts: TwinSourceFactInput[] = [
      { path: "src/x.ts", line: 1, kind: "source", text: "export function checkThing(a: number): number {" },
      { path: "src/x.ts", line: 2, kind: "source", text: "if (a > 0) return a" },
      { path: "tests/x.test.ts", line: 1, kind: "test", text: "it('checks a thing', () => {" },
      { path: "tests/x.test.ts", line: 2, kind: "test", text: "expect(checkThing(5)).toBe(5)" },
    ];
    const scenarios = reconstructScenarios(facts, new Set(["tests/x.test.ts"]));
    const r = buildPlanFromEvidence({
      focus: "Checking a thing returns the wrong result.",
      target: { name: "checkThing", path: "src/x.ts", line: 1, endLine: 2 },
      scenarios: [scenarios[0]],
      sourceFacts: facts,
      knownFunctions: new Set(["checkThing"]),
      functions: [{ name: "checkThing", path: "src/x.ts", line: 1, endLine: 2 }],
      selectedFunctionNames: new Set(["checkThing"]),
    });
    // No causal operation/condition -> never invent a repair.
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.plan).toBeNull();
  });

  it("does not leak the persistence write even when it is the final mutation", () => {
    const r = syntheticPlan();
    if (r.status !== "READY") throw new Error("expected READY");
    const all = JSON.stringify(r.plan);
    expect(all).not.toContain("store.orders.set");
  });
});

// ---------------------------------------------------------------------------
// Commerce fixture (real analyzer) — cart removal and sibling isolation.
// ---------------------------------------------------------------------------
interface Fixture {
  functions: Array<{ name?: string; path?: string; line?: number; endLine?: number }>;
  tests: Array<{ name?: string; path?: string; file?: string }>;
  relationships: Array<{ from?: string; to?: string; type?: string; caller?: string }>;
  sourceFacts: ReturnType<typeof buildSourceFacts>;
  scenarios: TestScenario[];
  knownFunctions: Set<string>;
}
let F: Fixture;

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
  const testPaths = new Set(twin.tests.map((t) => t.path).filter(Boolean) as string[]);
  F = {
    functions: twin.functions,
    tests: twin.tests,
    relationships: twin.relationships,
    sourceFacts,
    scenarios: reconstructScenarios(sourceFacts, testPaths),
    knownFunctions: new Set(twin.functions.map((f) => f.name).filter(Boolean) as string[]),
  };
});

function fixtureTarget(name: string) {
  const fn = F.functions.find((f) => f.name === name);
  if (!fn) throw new Error(`fixture target missing: ${name}`);
  return fn;
}
function fixtureScenario(descriptionIncludes: string): TestScenario {
  const s = F.scenarios.find((sc) => sc.description.includes(descriptionIncludes));
  if (!s) throw new Error(`fixture scenario missing: ${descriptionIncludes}`);
  return s;
}

describe("fixture: cart mutation is preserved and scoped (req #2)", () => {
  it("keeps the removal mutation and the selected scenario's assertion", () => {
    const r = buildPlanFromEvidence({
      focus: CART_REPORT,
      target: fixtureTarget("removeItem"),
      scenarios: [fixtureScenario("removes only the requested line")],
      sourceFacts: F.sourceFacts,
      knownFunctions: F.knownFunctions,
      functions: F.functions,
      selectedFunctionNames: new Set(["removeItem"]),
    });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.repairContract.relevantOperation).toContain("cart.items.delete");
    expect(r.plan.repairContract.relevantAssertions.join("\n")).toContain("latteLines");
    const all = JSON.stringify(r.plan);
    expect(all).not.toContain("users.test");
    expect(all).not.toContain("resetPassword");
  });
});

describe("fixture: sibling scenario isolation (reqs #3, #6)", () => {
  const discount = () => fixtureScenario("applies a discount code to the order total");
  const noDiscount = () => fixtureScenario("charges the full price without a discount");

  it("uses the selected scenario and never a sibling's assertion", () => {
    const r = buildPlanFromEvidence({
      focus: DISCOUNT_REPORT,
      target: fixtureTarget("createOrder"),
      scenarios: [discount(), noDiscount()],
      sourceFacts: F.sourceFacts,
      knownFunctions: F.knownFunctions,
      functions: F.functions,
      selectedFunctionNames: new Set(["createOrder", "getCartTotal"]),
    });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.repairContract.requiredOutcome).toContain("toBe(180)");
    expect(JSON.stringify(r.plan)).not.toContain("toBe(200)");
  });

  it("honours a sibling selected first (selection is authoritative)", () => {
    const r = buildPlanFromEvidence({
      focus: DISCOUNT_REPORT,
      target: fixtureTarget("createOrder"),
      scenarios: [noDiscount(), discount()],
      sourceFacts: F.sourceFacts,
      knownFunctions: F.knownFunctions,
      functions: F.functions,
      selectedFunctionNames: new Set(["createOrder", "getCartTotal"]),
    });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    expect(r.plan.repairContract.requiredOutcome).toContain("toBe(200)");
  });
});

describe("fixture: persistence cannot become the operation (req #4)", () => {
  it("prefers the order-total assignment over store.orders.set", () => {
    const r = buildPlanFromEvidence({
      focus: DISCOUNT_REPORT,
      target: fixtureTarget("createOrder"),
      scenarios: [fixtureScenario("applies a discount code to the order total")],
      sourceFacts: F.sourceFacts,
      knownFunctions: F.knownFunctions,
      functions: F.functions,
      selectedFunctionNames: new Set(["createOrder", "getCartTotal"]),
    });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    const op = r.plan.repairContract.relevantOperation;
    expect(op).toContain("total");
    expect(op).not.toContain("store.orders.set");
  });
});

describe("agent integration: selected evidence wins over a model hypothesis", () => {
  it("grounds the discount report on the repository operation without a model", async () => {
    const result = await runInvestigationAgent({
      llm: null,
      jobId: "job-1",
      repository: "acme/commerce",
      ref: "main",
      commitSha: "a".repeat(40),
      scripts: { test: "vitest run" },
      packageManager: "pnpm",
      report: DISCOUNT_REPORT,
      functions: SYN_FUNCTIONS,
      tests: SYN_TESTS,
      relationships: [{ from: "createOrder", to: "applyDiscount", type: "CALLS", caller: "createOrder" }],
      sourceFacts: SYN_FACTS,
    });
    expect(result.deterministic.status).toBe("READY");
    if (result.deterministic.status !== "READY") return;
    const plan = result.deterministic.plan;
    expect(plan.repairContract.relevantOperation).toContain("applyDiscount");
    expect(plan.repairContract.relevantCondition).toContain("discountCode === 'SAVE10'");
    // The contract never uses the persistence write as its operation.
    expect(plan.repairContract.relevantOperation).not.toContain("store.orders.set");
    expect(plan.repairContract.sourceEvidence.join("\n")).not.toContain("store.orders.set");
  });

  it("cannot be overridden by a contradictory model summary (req #5)", async () => {
    const LLM: LlmConfig = { baseUrl: "http://fake", apiKey: "k", model: "fake" };
    vi.mocked(chatComplete).mockImplementation(async (_cfg, messages) => {
      const user = messages.map((m) => m.content).join("\n");
      if (user.includes("Decompose the report")) {
        return JSON.stringify({ observedBehavior: "x", expectedBehavior: "y", queries: ["discount order total"] });
      }
      return JSON.stringify({
        selectedEvidence: [],
        candidateTarget: null,
        // A plausible but repository-contradicted hypothesis.
        hypothesis: "The discount code is not being passed, so applyDiscount receives undefined.",
        sufficient: false,
        clarificationQuestion: null,
        clarificationOptions: [],
      });
    });
    const result = await runInvestigationAgent({
      llm: LLM,
      jobId: "job-1",
      repository: "acme/commerce",
      ref: "main",
      commitSha: "a".repeat(40),
      scripts: { test: "vitest run" },
      packageManager: "pnpm",
      report: DISCOUNT_REPORT,
      functions: SYN_FUNCTIONS,
      tests: SYN_TESTS,
      relationships: [{ from: "createOrder", to: "applyDiscount", type: "CALLS", caller: "createOrder" }],
      sourceFacts: SYN_FACTS,
    });
    expect(result.deterministic.status).toBe("READY");
    if (result.deterministic.status !== "READY") return;
    const c = result.deterministic.plan.repairContract;
    // Grounded in the repository, not the model's unsupported claim.
    expect(c.relevantOperation).toContain("applyDiscount(subtotal, discountCode)");
    expect(c.relevantCondition).toContain("discountCode === 'SAVE10'");
    expect(JSON.stringify(c)).not.toContain("receives undefined");
  });
});
