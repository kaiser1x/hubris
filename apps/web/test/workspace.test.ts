import { describe, expect, it } from "vitest";
import {
  activeJobIdPreference,
  jobIdFromSearch,
  jobRepositoryContext,
  repoNameFromUrl,
  REPOSITORY_UNAVAILABLE_LABEL,
  workspaceHref,
  writeActiveJobId,
  readActiveJobId,
} from "../app/lib/workspace";
import { resolveLiveOverview, type LiveJob } from "../app/lib/live-twin";

function makeJob(over: Partial<LiveJob> = {}): LiveJob {
  return {
    id: "job-1",
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    result: {
      jobId: "job-1",
      repository: { id: "r", name: "kaiser1x/ts-js-dummy", analysisStatus: "complete" },
      stats: { packages: 1, functions: 1, classes: 0, endpoints: 1, tests: 0, relationships: 0, analysisMs: 1 },
      sample: { functions: [], endpoints: [] },
    },
    error: null,
    ...over,
  };
}

describe("jobRepositoryContext", () => {
  it("derives the repository identity from the analyzed job", () => {
    const ctx = jobRepositoryContext(makeJob());
    expect(ctx.hasContext).toBe(true);
    expect(ctx.repoName).toBe("kaiser1x/ts-js-dummy");
    expect(ctx.owner).toBe("kaiser1x");
    expect(ctx.repo).toBe("ts-js-dummy");
    expect(ctx.label).toBe("kaiser1x/ts-js-dummy");
  });

  it("shows the newly analyzed repository, never the old one", () => {
    const b = makeJob({
      id: "job-b",
      repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
      result: {
        ...(makeJob().result as object),
        repository: { id: "r2", name: "kaiser1x/test2-codebase", analysisStatus: "complete" },
      } as LiveJob["result"],
    });
    const ctx = jobRepositoryContext(b);
    expect(ctx.repoName).toBe("kaiser1x/test2-codebase");
    expect(ctx.label).not.toContain("ts-js-dummy");
  });

  it("reads the analyzed ref and commit from the persisted job", () => {
    const ctx = jobRepositoryContext(
      makeJob({
        result: {
          ...(makeJob().result as object),
          ref: "hubris/buggy-idempotency",
          commitSha: "2ea74c79a".padEnd(40, "0"),
        } as unknown as LiveJob["result"],
      })
    );
    expect(ctx.ref).toBe("hubris/buggy-idempotency");
    expect(ctx.commitSha).toBe("2ea74c79a".padEnd(40, "0"));
  });

  it("derives identity from the job's own persisted repoUrl for legacy jobs", () => {
    const legacy = makeJob({ result: null });
    const ctx = jobRepositoryContext(legacy);
    // The repoUrl is real persisted job data, so the real repository name
    // is derived from it — this is the job's own identity, not a substitute.
    expect(ctx.hasContext).toBe(true);
    expect(ctx.repoName).toBe("kaiser1x/ts-js-dummy");
    expect(ctx.label).toBe("kaiser1x/ts-js-dummy");
  });

  it("never substitutes another repository when identity is missing", () => {
    const b = makeJob({ result: null });
    const ctx = jobRepositoryContext({ ...b, repoUrl: "" });
    expect(ctx.hasContext).toBe(false);
    expect(ctx.repoName).toBeNull();
    expect(ctx.label).toBe(REPOSITORY_UNAVAILABLE_LABEL);
    expect(ctx.label).not.toContain("ts-js-dummy");
    expect(ctx.label).not.toContain("test2-codebase");
  });

  it("reports no job as repository-unavailable, never a demo fallback", () => {
    const ctx = jobRepositoryContext(null);
    expect(ctx.hasContext).toBe(false);
    expect(ctx.label).toBe(REPOSITORY_UNAVAILABLE_LABEL);
    expect(ctx.label).not.toContain("ts-js-dummy");
  });

  it("keeps repository A and B fully isolated", () => {
    const a = jobRepositoryContext(makeJob());
    const b = jobRepositoryContext(
      makeJob({
        id: "job-b",
        result: {
          ...(makeJob().result as object),
          repository: { id: "r2", name: "kaiser1x/test2-codebase", analysisStatus: "complete" },
        } as LiveJob["result"],
      })
    );
    expect(a.repoName).toBe("kaiser1x/ts-js-dummy");
    expect(b.repoName).toBe("kaiser1x/test2-codebase");
    expect(a.jobId).not.toBe(b.jobId);
  });
});

describe("active job id precedence", () => {
  function storage(initial: string | null): Storage {
    const map = new Map<string, string>();
    if (initial) map.set("hubris.activeJobId", initial);
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => void map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  it("an explicit ?jobId= in the URL wins over the persisted active job", () => {
    const params = new URLSearchParams("jobId=job-b");
    expect(activeJobIdPreference(params, storage("job-a"))).toBe("job-b");
  });

  it("falls back to the persisted active job when no URL id exists", () => {
    expect(activeJobIdPreference(new URLSearchParams(), storage("job-a"))).toBe("job-a");
  });

  it("returns null when neither an explicit nor a persisted id exists", () => {
    expect(activeJobIdPreference(new URLSearchParams(), storage(null))).toBeNull();
  });

  it("ignores unsafe job id shapes", () => {
    expect(jobIdFromSearch(new URLSearchParams("jobId=bad;rm -rf"))).toBeNull();
    expect(jobIdFromSearch(new URLSearchParams("jobId="))).toBeNull();
  });

  it("writes and clears the active job id in browser storage", () => {
    const store = storage(null);
    writeActiveJobId("job-a", store);
    expect(readActiveJobId(store)).toBe("job-a");
    writeActiveJobId(null, store);
    expect(readActiveJobId(store)).toBeNull();
  });

  it("preserves the exact workspace identity in context-bound links", () => {
    expect(workspaceHref("/forge", { jobId: "job-a", investigationId: "inv-a" })).toBe(
      "/forge?jobId=job-a&investigationId=inv-a"
    );
  });
});

describe("repoNameFromUrl", () => {
  it("normalizes owner/repo from clone urls", () => {
    expect(repoNameFromUrl("https://github.com/kaiser1x/test2-codebase.git")).toBe(
      "kaiser1x/test2-codebase"
    );
    expect(repoNameFromUrl("https://github.com/kaiser1x/ts-js-dummy")).toBe(
      "kaiser1x/ts-js-dummy"
    );
  });

  it("returns null for unparsable urls", () => {
    expect(repoNameFromUrl(null)).toBeNull();
    expect(repoNameFromUrl("not a url")).toBeNull();
  });
});

describe("overview resolves the current repository's twin", () => {
  it("renders test2-codebase as the analyzed repository", () => {
    const full = {
      functions: [
        { id: "f1", name: "fetchWidget", path: "src/widgets.ts", line: 1, column: 1 },
      ],
      classes: [],
      endpoints: [{ path: "/widgets", method: "GET", file: "src/widgets.ts" }],
      tests: [],
      relationships: [],
    };
    const b = makeJob({
      id: "job-b",
      repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
      result: {
        ...(makeJob().result as object),
        repository: { id: "r2", name: "kaiser1x/test2-codebase", analysisStatus: "complete" },
        full,
      } as unknown as LiveJob["result"],
    });
    const live = resolveLiveOverview(b);
    expect(live).not.toBeNull();
    expect(live!.name).toBe("kaiser1x/test2-codebase");
    expect(live!.name).not.toContain("ts-js-dummy");
  });
});
