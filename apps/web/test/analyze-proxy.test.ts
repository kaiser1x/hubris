import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/analyze/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(body: unknown): Request {
  return new Request("http://localhost:3000/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/analyze proxy", () => {
  it("forwards the selected repository to the analysis API", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ repoUrl: "https://github.com/example/repo" }));
      return Response.json({ jobId: "job-b" }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(request({ repoUrl: "https://github.com/example/repo" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobId: "job-b" });
  });

  it("rejects malformed input without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost:3000/api/analyze", { method: "POST", body: "{bad" }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
