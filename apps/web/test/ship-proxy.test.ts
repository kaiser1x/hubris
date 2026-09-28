// Regression test for the SHIP connection path. The SHIP page POSTs relative
// /api/ship; this route must forward the upstream outcome honestly: real
// connection failures → explicit 502, while upstream errors (e.g. an
// ineligible run answering 409) must be forwarded with their status.
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "../app/api/ship/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(body: unknown) {
  return new Request("http://localhost:3000/api/ship", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ship proxy", () => {
  it("forwards the exact body to the HUBRIS API /api/ship endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ pullRequest: { prNumber: 7 } }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { jobId: "job-1", forgeRunId: "run-2" };
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pullRequest: { prNumber: 7 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/api/ship");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("HUBRIS/0.1.0");
    expect(init.body).toBe(JSON.stringify(body));
  });

  it("preserves an upstream error status and body (e.g. ineligible run 409)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Cannot create PR. The repair is not verified." }, { status: 409 })
      )
    );
    const res = await POST(req({ jobId: "j", forgeRunId: "r" }));
    expect(res.status).toBe(409);
    const data = (await res.json()) as Record<string, unknown>;
    expect(String(data.error)).toContain("Cannot create PR");
  });

  it("API unavailable → explicit 502 with the existing connection pattern", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );
    const res = await POST(req({ jobId: "j", forgeRunId: "r" }));
    expect(res.status).toBe(502);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Failed to connect to analysis service");
    expect(String(data.hint)).toContain("http://localhost:3001");
  });

  it("invalid JSON body → 400 without touching the API", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const bad = new Request("http://localhost:3000/api/ship", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
