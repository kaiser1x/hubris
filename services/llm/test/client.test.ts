import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildForgePrompt,
  buildInvestigatePrompt,
  chatComplete,
  INVESTIGATE_SYSTEM,
  llmConfigFromEnv,
} from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("llmConfigFromEnv", () => {
  it("returns null without key or model", () => {
    expect(llmConfigFromEnv({})).toBeNull();
    expect(llmConfigFromEnv({ NEBIUS_API_KEY: "k" })).toBeNull();
    expect(llmConfigFromEnv({ NEBIUS_MODEL: "m" })).toBeNull();
  });

  it("builds config with default base URL", () => {
    expect(
      llmConfigFromEnv({ NEBIUS_API_KEY: "k", NEBIUS_MODEL: "m" })
    ).toEqual({
      baseUrl: "https://api.studio.nebius.com/v1",
      apiKey: "k",
      model: "m",
    });
  });

  it("honors NEBIUS_BASE_URL", () => {
    expect(
      llmConfigFromEnv({
        NEBIUS_API_KEY: "k",
        NEBIUS_MODEL: "m",
        NEBIUS_BASE_URL: "https://example.test/v1/",
      })?.baseUrl
    ).toBe("https://example.test/v1/");
  });
});

describe("buildInvestigatePrompt", () => {
  it("summarizes the twin and appends the question", () => {
    const prompt = buildInvestigatePrompt(
      {
        repoName: "acme/api",
        stats: { functions: 10, classes: 2, endpoints: 3, tests: 4, relationships: 20 },
        functionNames: ["create", "refund"],
        endpoints: ["POST /pay"],
      },
      "Where can double-charge happen?"
    );
    expect(prompt).toContain("acme/api");
    expect(prompt).toContain("create, refund");
    expect(prompt).toContain("Where can double-charge happen?");
  });

  it("falls back to a default question", () => {
    const prompt = buildInvestigatePrompt({
      repoName: "x/y",
      stats: { functions: 0, classes: 0, endpoints: 0, tests: 0, relationships: 0 },
      functionNames: [],
      endpoints: [],
    });
    expect(prompt).toContain("(none)");
    expect(prompt.length).toBeGreaterThan(50);
  });
});

describe("buildForgePrompt", () => {
  it("includes functions, focus, and the three-section contract", () => {
    const prompt = buildForgePrompt({
      repoName: "acme/api",
      stats: { functions: 5, classes: 1, endpoints: 2, tests: 1, relationships: 9 },
      functions: [{ name: "charge", file: "src/pay.ts", line: 12 }],
      endpoints: ["POST /pay"],
      relationships: ["src/pay.ts CALLS validate"],
      focus: "charge",
    });
    expect(prompt).toContain("charge (src/pay.ts:12)");
    expect(prompt).toContain("Focus area: charge");
    expect(prompt).toContain("PATCH");
    expect(prompt).toContain("TEST");
    expect(prompt).toContain("WHY");
  });

  it("falls back to a default instruction", () => {
    const prompt = buildForgePrompt({
      repoName: "x/y",
      stats: { functions: 0, classes: 0, endpoints: 0, tests: 0, relationships: 0 },
      functions: [],
      endpoints: [],
      relationships: [],
    });
    expect(prompt).toContain("most valuable minimal fix");
  });
});

describe("chatComplete", () => {
  it("posts an OpenAI-compatible request and returns content", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await chatComplete(
      { baseUrl: "https://example.test/v1/", apiKey: "k", model: "m" },
      [{ role: "system", content: INVESTIGATE_SYSTEM }, { role: "user", content: "hi" }]
    );
    expect(out).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("throws on API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(
      chatComplete({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m" }, [
        { role: "user", content: "hi" },
      ])
    ).rejects.toThrow("401");
  });

  it("throws on empty choices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    );
    await expect(
      chatComplete({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m" }, [
        { role: "user", content: "hi" },
      ])
    ).rejects.toThrow("no content");
  });
});
