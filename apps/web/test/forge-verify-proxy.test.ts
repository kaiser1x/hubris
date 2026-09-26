// Regression test for the VERIFY IN SANDBOX connection path.
// The button POSTs relative /api/forge-verify; this route must forward the
// upstream outcome honestly: real connection failures → explicit 502, while
// upstream errors (e.g. a stale API answering 404 text) must be forwarded
// with their status — never misreported as "Failed to connect".
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "../app/api/forge-verify/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(body: unknown) {
  return new Request("http://172.27.176.1:3000/api/forge-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/forge-verify proxy", () => {
  it("forwards an upstream non-JSON error with its status, not 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("404 Not Found", { status: 404 }))
    );
    const res = await POST(req({}));
    expect(res.status).toBe(404);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).not.toBe("Failed to connect to analysis service");
  });

  it("forwards a successful verification payload untouched", async () => {
    const payload = { jobId: "j", forgeRun: { status: "VERIFIED", verified: true } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload, { status: 200 }))
    );
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("API unavailable → explicit 502, never infinite loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(502);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.error).toBe("Failed to connect to analysis service");
  });

  it("invalid JSON body → 400 without touching the API", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const bad = new Request("http://172.27.176.1:3000/api/forge-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
