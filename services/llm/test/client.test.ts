import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildForgePrompt,
  buildInvestigatePrompt,
  chatComplete,
  INVESTIGATE_SYSTEM,
  llmConfigFromEnv,
  ModelError,
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

  it("grounds the model in real paths and route bindings", () => {
    const prompt = buildInvestigatePrompt({
      repoName: "acme/api",
      stats: { functions: 2, classes: 0, endpoints: 1, tests: 0, relationships: 3 },
      functionNames: ["getUser"],
      functionDetails: ["getUser — src/users.ts:12"],
      routes: ["GET /users/:id → users.getUser"],
      endpoints: ["GET /users/:id"],
    });
    expect(prompt).toContain("getUser — src/users.ts:12");
    expect(prompt).toContain("GET /users/:id → users.getUser");
    expect(prompt).toContain("Do not invent paths");
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

describe("chatComplete error taxonomy", () => {
  const cfg = { baseUrl: "https://example.test/v1", apiKey: "k", model: "m" };
  const msgs = [{ role: "user", content: "hi" }] as Parameters<typeof chatComplete>[1];

  it("1. success returns content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }))
    );
    await expect(chatComplete(cfg, msgs)).resolves.toBe("ok");
  });

  it("2. HTTP 502 maps to http with status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const err = await chatComplete(cfg, msgs).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(502);
  });

  it("3. HTTP 200 with empty content maps to empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }))
    );
    const err = await chatComplete(cfg, msgs).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("empty");
  });

  it("4. malformed JSON maps to parse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not json", { status: 200 })));
    const err = await chatComplete(cfg, msgs).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("parse");
  });

  it("5. aborted signal maps to timeout and settles fast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
        await new Promise<never>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(new DOMException("signal timed out", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("signal timed out", "AbortError")),
            { once: true }
          );
        });
      })
    );
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);
    const t0 = Date.now();
    const err = await chatComplete(cfg, msgs, { signal: ctl.signal }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("timeout");
  });

  it("6. transport failure maps to transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      })
    );
    const err = await chatComplete(cfg, msgs).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("transport");
  });
});

describe("chatComplete response_format", () => {
  it("sends response_format only when requested", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { baseUrl: "https://example.test/v1/", apiKey: "k", model: "m" };
    const msgs = [{ role: "user", content: "hi" }] as Parameters<typeof chatComplete>[1];
    await chatComplete(cfg, msgs, { responseFormat: "json_object" });
    const [, withFormat] = fetchMock.mock.calls[0];
    expect(JSON.parse(withFormat?.body as string).response_format).toEqual({
      type: "json_object",
    });
    await chatComplete(cfg, msgs);
    const [, withoutFormat] = fetchMock.mock.calls[1];
    expect(JSON.parse(withoutFormat?.body as string)).not.toHaveProperty("response_format");
  });
});
