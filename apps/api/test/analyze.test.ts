import { describe, it, expect, vi, afterEach } from "vitest";
import { app, toSafeCloneUrl } from "../src/app";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/jobs", () => {
  it("returns 503 when no DATABASE_URL is configured", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
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
    expect(process.env.DATABASE_URL).toBeUndefined();
    const res = await app.request("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns 503 when no DATABASE_URL is configured", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
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
