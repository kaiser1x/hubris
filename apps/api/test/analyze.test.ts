import * as path from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { app, toRepoRelative, toSafeCloneUrl } from "../src/app";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/jobs", () => {
  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/jobs");
    expect(res.status).toBe(503);
  });
});

describe("POST /api/investigate validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/forge validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/forge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/forge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus: "charge" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/forge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/reproduce validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/reproduce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId and script", async () => {
    const res = await app.request("/api/reproduce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/reproduce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", script: "echo hi" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/reproduce checkout validation", () => {
  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/reproduce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        script: "echo hi",
        checkout: true,
        ref: "bad;rm -rf",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an overlong ref", async () => {
    const res = await app.request("/api/reproduce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        script: "echo hi",
        ref: "a".repeat(101),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/verify validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId and script", async () => {
    const res = await app.request("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", script: "exit 0" }),
    });
    expect(res.status).toBe(503);
  });

  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        script: "exit 0",
        checkout: true,
        ref: "$(whoami)",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(503);
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "hubris-api" });
  });
});

describe("GET /api/analyze", () => {
  it("returns 400 without repo", async () => {
    const res = await app.request("/api/analyze");
    expect(res.status).toBe(400);
  });

  it("returns repo metadata on GitHub success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            name: "Hello-World",
            full_name: "octocat/Hello-World",
            owner: { login: "octocat" },
            description: "fixture",
            language: null,
            private: false,
            html_url: "https://github.com/octocat/Hello-World",
            stargazers_count: 1,
            forks_count: 2,
          }),
          { status: 200 }
        )
      )
    );
    const res = await app.request("/api/analyze?repo=octocat/Hello-World");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repository.fullName).toBe("octocat/Hello-World");
    expect(body.analysisStatus).toBe("pending");
  });

  it("propagates GitHub error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 }))
    );
    const res = await app.request("/api/analyze?repo=octocat/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/analyze validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without repoUrl", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-GitHub URLs", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://evil.example.com/x/y" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/kaiser1x/ts-js-dummy",
        ref: "bad;rm -rf",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("toRepoRelative", () => {
  it("strips the clone-dir prefix and normalizes separators", () => {
    const tmp = path.join("tmp", "hubris-1");
    expect(toRepoRelative(tmp, path.join(tmp, "src", "a.ts"))).toBe(
      ["src", "a.ts"].join("/")
    );
    expect(toRepoRelative(tmp, path.join(tmp, "index.js"))).toBe("index.js");
  });

  it("leaves non-clone paths untouched", () => {
    expect(toRepoRelative(path.join("tmp", "hubris-1"), "express")).toBe("express");
  });
});

describe("toSafeCloneUrl", () => {
  it("normalizes owner/repo URLs", () => {
    expect(toSafeCloneUrl("https://github.com/octocat/Hello-World")).toBe(
      "https://github.com/octocat/Hello-World.git"
    );
  });

  it("strips .git suffix", () => {
    expect(toSafeCloneUrl("https://github.com/octocat/Hello-World.git")).toBe(
      "https://github.com/octocat/Hello-World.git"
    );
  });

  it.each([
    "http://github.com/octocat/Hello-World",
    "https://gitlab.com/octocat/Hello-World",
    "https://github.com/onlyowner",
    "not a url",
    "",
  ])("rejects %s", (raw) => {
    expect(toSafeCloneUrl(raw)).toBeNull();
  });
});

describe("POST /api/analyze ref validation", () => {
  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/kaiser1x/ts-js-dummy",
        ref: "bad;rm -rf",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an overlong ref", async () => {
    const res = await app.request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/kaiser1x/ts-js-dummy",
        ref: "a".repeat(101),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/forge-structured ref validation", () => {
  it("returns 400 for an unsafe caller ref override", async () => {
    const res = await app.request("/api/forge-structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        focus: "do things",
        ref: "bad;rm -rf",
      }),
    });
    expect(res.status).toBe(400);
  });
});
