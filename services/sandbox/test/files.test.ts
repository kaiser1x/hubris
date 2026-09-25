import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_EXECUTION_LIMITS,
  executionLimitsFromEnv,
  spawnInstance,
  uploadFile,
} from "../src/index";

const CONFIG = { baseUrl: "https://example.test/sb", apiKey: "k", projectId: "p" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("posts raw bytes as octet-stream and returns uuid/sha256/size", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ uuid: "file-1", sha256: "abc123", size: 5 }),
          { status: 201 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await uploadFile(CONFIG, new TextEncoder().encode("hello"));
    expect(out).toEqual({ uuid: "file-1", sha256: "abc123", size: 5 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/sb/v1/files");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers.Project).toBe("p");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("throws on auth errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(uploadFile(CONFIG, new Uint8Array())).rejects.toThrow("401");
  });

  it("throws when the response has no uuid/sha256", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 201 }))
    );
    await expect(uploadFile(CONFIG, new Uint8Array())).rejects.toThrow("uuid");
  });
});

describe("spawnInstance files", () => {
  it("passes the files map through to the spawn body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uuid: "op-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await spawnInstance(CONFIG, {
      command: "tar -xf /tmp/up/repo.tar",
      image: "tag:busybox:latest",
      files: { "/tmp/up/repo.tar": { uuid: "file-1" } },
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.files).toEqual({ "/tmp/up/repo.tar": { uuid: "file-1" } });
  });

  it("omits files when not provided", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uuid: "op-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await spawnInstance(CONFIG, { command: "echo hi", image: "tag:busybox:latest" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("files");
  });
});

describe("spawnInstance execution limits", () => {
  it("passes truncate and layer caps through to the spawn body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uuid: "op-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await spawnInstance(CONFIG, {
      command: "echo hi",
      image: "tag:busybox:latest",
      truncateOutputAt: 65535,
      maxLayerBytes: 1073741824,
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.truncate_output_at).toBe(65535);
    expect(body.resources_limits).toEqual({ max_layer_bytes: 1073741824 });
  });

  it("omits caps when not provided", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uuid: "op-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await spawnInstance(CONFIG, { command: "echo hi", image: "tag:busybox:latest" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).not.toHaveProperty("truncate_output_at");
    expect(body).not.toHaveProperty("resources_limits");
  });
});

describe("executionLimitsFromEnv", () => {
  it("returns conservative defaults", () => {
    expect(executionLimitsFromEnv({})).toEqual(DEFAULT_EXECUTION_LIMITS);
    expect(
      executionLimitsFromEnv({ HUBRIS_SANDBOX_TIMEOUT: "nope", HUBRIS_SANDBOX_WAIT_MS: "-1" })
    ).toEqual(DEFAULT_EXECUTION_LIMITS);
  });

  it("honors overrides", () => {
    expect(
      executionLimitsFromEnv({
        HUBRIS_SANDBOX_TIMEOUT: "300",
        HUBRIS_SANDBOX_WAIT_MS: "330000",
        HUBRIS_MAX_OUTPUT_BYTES: "65535",
        HUBRIS_MAX_LAYER_BYTES: "1073741824",
      })
    ).toEqual({
      commandTimeoutS: 300,
      waitMs: 330000,
      maxOutputBytes: 65535,
      maxLayerBytes: 1073741824,
    });
  });
});
