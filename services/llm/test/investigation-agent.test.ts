import { describe, it, expect } from "vitest";
import {
  buildInvestigationUnderstandingPrompt,
  buildInvestigationSynthesisPrompt,
  INVESTIGATION_AGENT_SYSTEM,
  parseAgentSynthesis,
  parseAgentUnderstanding,
} from "../src/index";

describe("investigation agent prompts", () => {
  it("asks for report decomposition and retrieval queries with no evidence", () => {
    const prompt = buildInvestigationUnderstandingPrompt({
      repoName: "acme/commerce",
      report: "Something is wrong with the discount.",
      evidence: "",
    });
    expect(prompt).toContain("acme/commerce");
    expect(prompt).toContain("Something is wrong with the discount.");
    expect(prompt).toContain("observedBehavior");
    expect(prompt).toContain("queries");
    expect(prompt).not.toContain("Retrieved repository evidence");
  });

  it("shows bounded evidence and forbids invented unit ids during synthesis", () => {
    const prompt = buildInvestigationSynthesisPrompt({
      repoName: "acme/commerce",
      report: "discount wrong",
      evidence: "[source:src/orders.ts] createOrder discount branch",
    });
    expect(prompt).toContain("[source:src/orders.ts]");
    expect(prompt).toContain("never invent ids");
    expect(prompt).toContain("clarificationQuestion");
    expect(prompt).toContain("sufficient=true");
  });

  it("carries a prior clarification into the resumed prompt", () => {
    const prompt = buildInvestigationUnderstandingPrompt({
      repoName: "acme/commerce",
      report: "Something is wrong with orders.",
      evidence: "",
      priorQuestion: "Is the problem the order total?",
      clarification: "Yes, the total.",
    });
    expect(prompt).toContain("Is the problem the order total?");
    expect(prompt).toContain("Yes, the total.");
  });

  it("states that model output is not evidence", () => {
    expect(INVESTIGATION_AGENT_SYSTEM.toLowerCase()).toContain("not evidence");
  });
});

describe("parseAgentUnderstanding", () => {
  it("parses a clean JSON object", () => {
    const parsed = parseAgentUnderstanding(
      JSON.stringify({
        observedBehavior: "SAVE10 leaves the total unchanged",
        expectedBehavior: "SAVE10 reduces the total by 10%",
        entities: ["order", "discount"],
        actions: ["createOrder"],
        ambiguities: [],
        queries: ["discount code", "order total"],
      })
    );
    expect(parsed?.observedBehavior).toContain("SAVE10");
    expect(parsed?.queries).toEqual(["discount code", "order total"]);
  });

  it("tolerates fenced output and surrounding prose", () => {
    const parsed = parseAgentUnderstanding(
      'Here you go:\n```json\n{"observedBehavior":"x","expectedBehavior":"y","queries":["q"]}\n```\nDone.'
    );
    expect(parsed?.observedBehavior).toBe("x");
    expect(parsed?.queries).toEqual(["q"]);
  });

  it("returns null on malformed output instead of throwing", () => {
    expect(parseAgentUnderstanding("not json")).toBeNull();
    expect(parseAgentUnderstanding("")).toBeNull();
    expect(parseAgentUnderstanding("{}")).toBeNull();
  });
});

describe("parseAgentSynthesis", () => {
  it("parses a sufficient proposal with cited unit ids", () => {
    const parsed = parseAgentSynthesis(
      JSON.stringify({
        selectedEvidence: ["test:tests/orders.test.ts#applies a discount"],
        candidateTarget: "createOrder",
        hypothesis: "The discount branch leaves the total unchanged.",
        sufficient: true,
        clarificationQuestion: null,
        clarificationOptions: [],
      })
    );
    expect(parsed?.sufficient).toBe(true);
    expect(parsed?.candidateTarget).toBe("createOrder");
  });

  it("parses a clarification request with grounded options", () => {
    const parsed = parseAgentSynthesis(
      JSON.stringify({
        selectedEvidence: [],
        candidateTarget: null,
        hypothesis: "",
        sufficient: false,
        clarificationQuestion: "Is the problem the order total?",
        clarificationOptions: ["the order total", "order creation", "discount validation"],
      })
    );
    expect(parsed?.sufficient).toBe(false);
    expect(parsed?.clarificationOptions).toHaveLength(3);
  });

  it("rejects a sufficiency claim that cites no evidence (fabrication guard)", () => {
    expect(
      parseAgentSynthesis(
        JSON.stringify({ selectedEvidence: [], sufficient: true, hypothesis: "trust me" })
      )
    ).toBeNull();
  });

  it("returns null on malformed output instead of throwing", () => {
    expect(parseAgentSynthesis("nope")).toBeNull();
    expect(parseAgentSynthesis("[]")).toBeNull();
  });
});
