import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLatestJob, resolveLiveOverview, type LiveJob } from "../app/lib/live-twin";

afterEach(() => {
  vi.unstubAllGlobals();
});

function job(partial: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    result: {
      stats: { functions: 3, classes: 1, endpoints: 2, tests: 4, relationships: 5 },
    },
    error: null,
    ...partial,
  };
}

describe("fetchLatestJob", () => {
  it("returns the first complete job with twin content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jobs: [job()] }), { status: 200 }))
    );
    const out = await fetchLatestJob();
    expect(out?.id).toBe("job-1");
  });

  it("returns null when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      })
    );
    await expect(fetchLatestJob()).resolves.toBeNull();
  });

  it("returns null on error status or malformed payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 502 })));
    await expect(fetchLatestJob()).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }))
    );
    await expect(fetchLatestJob()).resolves.toBeNull();
  });

  it("skips jobs with no twin content", async () => {
    const empty = job({ result: { stats: { functions: 0, classes: 0 } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ jobs: [empty] }), { status: 200 }))
    );
    await expect(fetchLatestJob()).resolves.toBeNull();
  });
});

describe("resolveLiveOverview", () => {
  const full = {
    functions: [{ id: "f1", name: "alpha", path: "src/a.ts", line: 1, column: 1 }],
    classes: [],
    endpoints: [{ path: "/x", method: "GET", file: "src/a.ts" }],
    tests: [],
    relationships: [],
  };

  function liveJob(result: unknown): LiveJob {
    return {
      id: "job-1",
      repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
      status: "complete",
      result: {
        jobId: "job-1",
        repository: { id: "r", name: "kaiser1x/ts-js-dummy", analysisStatus: "complete" },
        stats: { packages: 1, functions: 1, classes: 0, endpoints: 1, tests: 0, relationships: 0, analysisMs: 1 },
        sample: { functions: [], endpoints: [] },
        ...(result as object),
      } as LiveJob["result"],
      error: null,
    };
  }

  it("resolves live content for a valid completed job", () => {
    const live = resolveLiveOverview(
      liveJob({ full })
    );
    expect(live).not.toBeNull();
    expect(live!.nodes.length).toBeGreaterThan(0);
    expect(live!.name).toContain("ts-js-dummy");
    expect(live!.cells.length).toBeGreaterThan(0);
  });

  it("returns null for missing or empty twins", () => {
    expect(resolveLiveOverview(null)).toBeNull();
    expect(resolveLiveOverview(liveJob(null))).toBeNull();
    expect(resolveLiveOverview(liveJob({ stats: { functions: 0, classes: 0 }, full }))).toBeNull();
  });

  it("returns null for malformed twins (never throws)", () => {
    expect(
      resolveLiveOverview(liveJob({ full: { ...full, functions: null } }))
    ).toBeNull();
    expect(resolveLiveOverview(liveJob({ full: null }))).toBeNull();
  });
});
