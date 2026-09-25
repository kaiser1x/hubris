import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getOperation,
  runCommand,
  sandboxConfigFromEnv,
  spawnInstance,
  waitOperation,
} from "../src/index";

const CONFIG = { baseUrl: "https://example.test/sb", apiKey: "k", projectId: "p" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

describe("sandboxConfigFromEnv", () => {
  it("returns null without key or project", () => {
    expect(sandboxConfigFromEnv({})).toBeNull();
    expect(sandboxConfigFromEnv({ NEBIUS_API_KEY: "k" })).toBeNull();
    expect(sandboxConfigFromEnv({ NEBIUS_PROJECT_ID: "p" })).toBeNull();
  });

  it("builds config with defaults and honors override", () => {
    expect(sandboxConfigFromEnv({ NEBIUS_API_KEY: "k", NEBIUS_PROJECT_ID: "p" })).toEqual({
      baseUrl: "https://api.tokenfactory.nebius.com/sandboxes",
      apiKey: "k",
      projectId: "p",
    });
    expect(
      sandboxConfigFromEnv({
        NEBIUS_API_KEY: "k",
        NEBIUS_PROJECT_ID: "p",
        NEBIUS_SANDBOX_URL: "https://example.test/sb/",
      })?.baseUrl
    ).toBe("https://example.test/sb/");
  });
});

describe("spawnInstance", () => {
  it("posts command+image with auth headers and returns the operation id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uuid: "op-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await spawnInstance(CONFIG, { command: "echo hi", image: "tag:busybox:latest" });
    expect(out).toEqual({ operationId: "op-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/sb/v1/instances");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers.Project).toBe("p");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ command: "echo hi", image: "tag:busybox:latest", shell: true, disposable: true });
  });

  it("throws on auth errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(spawnInstance(CONFIG, { command: "x", image: "y" })).rejects.toThrow("401");
  });
});

describe("waitOperation", () => {
  it("polls until terminal and decodes base64 streams", async () => {
    const fetchMock = vi
      .fn(async () => new Response(JSON.stringify({ state: "EXECUTING" }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ state: "EXECUTING" }), { status: 200 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              state: "SUCCESS",
              metadata: {
                result: {
                  state: { exit_code: 0, timed_out: false },
                  stdout: { value: b64("hi\n"), encoding: "base64" },
                  stderr: { value: "", encoding: "ascii" },
                },
              },
            }),
            { status: 200 }
          )
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await waitOperation(CONFIG, "op-1", { pollMs: 1 });
    expect(result).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false });
  });
});

describe("runCommand", () => {
  it("spawns then waits", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/instances")) {
        return new Response(JSON.stringify({ uuid: "op-9" }), { status: 201 });
      }
      return new Response(
        JSON.stringify({
          state: "SUCCESS",
          result: { state: { exit_code: 3 }, stdout: { value: "out", encoding: "ascii" } },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runCommand(CONFIG, { command: "exit 3", image: "tag:busybox:latest" });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out");
  });
});

describe("getOperation", () => {
  it("reports non-terminal operations without a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "EXECUTING" }), { status: 200 }))
    );
    const out = await getOperation(CONFIG, "op-1");
    expect(out).toEqual({ terminal: false, result: null });
  });
});
