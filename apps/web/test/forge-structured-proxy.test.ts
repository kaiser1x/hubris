// The Forge button POSTs /api/forge-structured. A Forge run can outlast the
// web function, so the proxy must end with an explicit, truthful error —
// never a platform kill (non-JSON 504) or a misleading "Failed to connect".
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POST, maxDuration } from "../app/api/forge-structured/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(body: unknown) {
  return new Request("http://localhost:3000/api/forge-structured", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/forge-structured proxy", () => {
  it("declares its platform limit (Vercel Hobby maximum)", () => {
    expect(maxDuration).toBe(300);
  });

  it("stops waiting before the platform kills it: aborts upstream with a timeout signal", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Response.json({ jobId: "j", forgeRun: { id: "r" } });
      })
    );
    await POST(req({ jobId: "j" }));
    expect(signal).toBeInstanceOf(AbortSignal);
    // The constant is not exported (Next.js route exports are restricted);
    // assert it sits below maxDuration in the source.
    const src = readFileSync(
      fileURLToPath(new URL("../app/api/forge-structured/route.ts", import.meta.url)),
      "utf8"
    );
    expect(src).toMatch(/UPSTREAM_TIMEOUT_MS = \(maxDuration - 10\) \* 1000/);
  });

  it("upstream timeout → 504 UPSTREAM_TIMEOUT with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(504);
    const data = (await res.json()) as { error: string; code: string };
    expect(data.code).toBe("UPSTREAM_TIMEOUT");
    expect(data.error).toMatch(/reload this page/);
    expect(data.error).not.toBe("Failed to connect to analysis service");
  });

  it("forwards the API's structured failure (status + code) untouched", async () => {
    const payload = { error: "The model proposed no change…", code: "NO_EDIT_PROPOSED", status: 422 };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload, { status: 422 })));
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(payload);
  });

  it("non-JSON upstream error keeps its status instead of becoming 'Failed to connect'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Gateway Timeout</html>", { status: 504 })));
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toContain("HTTP 504");
  });

  it("API unreachable → 502 Failed to connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const res = await POST(req({ jobId: "j" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("Failed to connect to analysis service");
  });
});
