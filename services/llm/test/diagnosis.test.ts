import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chatComplete,
  diagnoseResponse,
  ModelError,
} from "../src/index";

const CFG = { baseUrl: "https://example.test/v1", apiKey: "k", model: "m" };
const MSGS = [{ role: "user", content: "hi" }] as Parameters<typeof chatComplete>[1];

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonBody(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status });
}

describe("diagnoseResponse classes", () => {
  it("A. empty string", () => {
    const d = diagnoseResponse({ choices: [{ message: { content: "", role: "a" } }] });
    expect(d.class).toBe("A_empty_string");
    expect(d.contentState).toBe("empty-string");
    expect(d.choicesCount).toBe(1);
  });

  it("B. null content", () => {
    const d = diagnoseResponse({ choices: [{ message: { content: null } }] });
    expect(d.class).toBe("B_null_content");
  });

  it("C. absent content", () => {
    const d = diagnoseResponse({ choices: [{ message: { role: "a" } }] });
    expect(d.class).toBe("C_absent_content");
    expect(d.messageKeys).toEqual(["role"]);
  });

  it("D. refusal", () => {
    const d = diagnoseResponse({
      choices: [{ message: { refusal: "no", role: "a" }, finish_reason: "stop" }],
    });
    expect(d.class).toBe("D_refusal");
    expect(d.refusalPresent).toBe(true);
    expect(d.finishReason).toBe("stop");
  });

  it("E. tool_calls without content", () => {
    const d = diagnoseResponse({
      choices: [{ message: { tool_calls: [{ id: "1" }], role: "a" } }],
    });
    expect(d.class).toBe("E_tool_calls");
    expect(d.toolCallsPresent).toBe(true);
    expect(d.toolCallsCount).toBe(1);
  });

  it("F. reasoning without content", () => {
    const d = diagnoseResponse({
      choices: [{ message: { reasoning_content: "thinking", role: "a" } }],
    });
    expect(d.class).toBe("F_reasoning_without_content");
    expect(d.reasoningPresent).toBe(true);
  });

  it("G. empty choices", () => {
    const d = diagnoseResponse({ choices: [] });
    expect(d.class).toBe("G_empty_choices");
    expect(d.choicesCount).toBe(0);
  });

  it("H. malformed bodies", () => {
    expect(diagnoseResponse(null).class).toBe("H_malformed");
    expect(diagnoseResponse("string").class).toBe("H_malformed");
    expect(diagnoseResponse({ nope: true }).class).toBe("G_empty_choices");
  });

  it("CONTENT passes through with keys recorded", () => {
    const d = diagnoseResponse({
      choices: [{ message: { content: "hi", role: "assistant" }, finish_reason: "stop" }],
    });
    expect(d.class).toBe("CONTENT");
    expect(d.choiceKeys).toEqual(["message", "finish_reason"]);
  });
});

describe("chatComplete attaches diagnosis on empty (never hangs)", () => {
  it.each([
    ["A", { choices: [{ message: { content: "" } }] }, "A_empty_string"],
    ["B", { choices: [{ message: { content: null } }] }, "B_null_content"],
    ["C", { choices: [{ message: {} }] }, "C_absent_content"],
    ["D", { choices: [{ message: { refusal: "no" } }] }, "D_refusal"],
    ["E", { choices: [{ message: { tool_calls: [{ id: "1" }] } }] }, "E_tool_calls"],
    ["F", { choices: [{ message: { reasoning_content: "t" } }] }, "F_reasoning_without_content"],
    ["G", { choices: [] }, "G_empty_choices"],
  ])("%s maps to kind=empty with detail", async (_label, body, cls) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonBody(body)));
    const t0 = Date.now();
    const err = await chatComplete(CFG, MSGS).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("empty");
    expect(err.detail.class).toBe(cls);
  });

  it("malformed JSON maps to parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{oops", { status: 200 })));
    const err = await chatComplete(CFG, MSGS).catch((e) => e);
    expect(err.kind).toBe("parse");
  });
});
