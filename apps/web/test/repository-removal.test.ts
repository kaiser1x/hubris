import { describe, expect, it, vi, afterEach } from "vitest";
import {
  ACTIVE_JOB_STORAGE_KEY,
  addRemovedRepo,
  isRepoRemoved,
  jobRepositoryIdentity,
  readActiveJobId,
  readRemovedRepos,
  removeRemovedRepo,
  REMOVED_REPOS_STORAGE_KEY,
  writeActiveJobId,
  writeRemovedRepos,
} from "../app/lib/workspace";
import type { LiveJob } from "../app/lib/live-twin";

// Minimal in-memory Storage with call recording, so we can prove removal
// touches ONLY the HUBRIS-side removed-repos key.
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void (calls.push(`set:${k}`), map.set(k, v)),
    removeItem: (k: string) => void (calls.push(`rm:${k}`), map.delete(k)),
    clear: () => void map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
  return { store, calls, map };
}

function makeJob(id: string, repoUrl: string, name: string): LiveJob {
  return {
    id,
    repoUrl,
    status: "complete",
    result: {
      jobId: id,
      repository: { id: "r", name, analysisStatus: "complete" },
      stats: { packages: 1, functions: 1, classes: 0, endpoints: 0, tests: 0, relationships: 0, analysisMs: 1 },
      sample: { functions: [], endpoints: [] },
    },
    error: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HUBRIS-only repository removal (persistence)", () => {
  it("removes a saved repository and it persists across a fresh read (reload)", () => {
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    // A fresh read from the same persisted storage is the reload case.
    expect(readRemovedRepos(store)).toEqual(["kaiser1x/test2-codebase"]);
    expect(isRepoRemoved("kaiser1x/test2-codebase", store)).toBe(true);
    expect(store.getItem(REMOVED_REPOS_STORAGE_KEY)).toContain("test2-codebase");
  });

  it("is idempotent — re-adding the same repository does not duplicate it", () => {
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    addRemovedRepo("kaiser1x/test2-codebase", store);
    expect(readRemovedRepos(store)).toEqual(["kaiser1x/test2-codebase"]);
  });

  it("undo restores the repository; it stays removed unless explicitly re-added", () => {
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    expect(isRepoRemoved("kaiser1x/test2-codebase", store)).toBe(true);
    removeRemovedRepo("kaiser1x/test2-codebase", store);
    expect(isRepoRemoved("kaiser1x/test2-codebase", store)).toBe(false);
    expect(readRemovedRepos(store)).toEqual([]);
  });

  it("removing one repository does not affect another", () => {
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    expect(isRepoRemoved("kaiser1x/ts-js-dummy", store)).toBe(false);
    expect(readRemovedRepos(store)).toEqual(["kaiser1x/test2-codebase"]);
  });

  it("ignores non-canonical identities and malformed persisted state", () => {
    const { store } = memoryStorage();
    writeRemovedRepos(["not a repo", "a/b/c", "ok/repo"], store);
    expect(readRemovedRepos(store)).toEqual(["ok/repo"]);
    store.setItem(REMOVED_REPOS_STORAGE_KEY, "{not json");
    expect(readRemovedRepos(store)).toEqual([]);
    expect(isRepoRemoved(null, store)).toBe(false);
    expect(isRepoRemoved("", store)).toBe(false);
  });

  it("touches ONLY the removed-repos key — jobs/history are never modified", () => {
    const { store, calls } = memoryStorage();
    writeActiveJobId("job-a", store);
    calls.length = 0;
    addRemovedRepo("kaiser1x/test2-codebase", store);
    // No job deletion, no other storage mutation.
    expect(calls).toEqual([`set:${REMOVED_REPOS_STORAGE_KEY}`]);
    // Unrelated persisted state is intact.
    expect(readActiveJobId(store)).toBe("job-a");
    expect(ACTIVE_JOB_STORAGE_KEY).toBe("hubris.activeJobId");
  });

  it("never calls fetch — no GitHub DELETE/archive request is possible", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    removeRemovedRepo("kaiser1x/test2-codebase", store);
    addRemovedRepo("kaiser1x/ts-js-dummy", store);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("duplicate analysis jobs share one canonical identity", () => {
  it("groups two jobs for the same repository so removal hides both", () => {
    const a = makeJob("job-a", "https://github.com/kaiser1x/test2-codebase.git", "kaiser1x/test2-codebase");
    const b = makeJob("job-b", "https://github.com/kaiser1x/test2-codebase.git", "kaiser1x/test2-codebase");
    expect(jobRepositoryIdentity(a)).toBe("kaiser1x/test2-codebase");
    expect(jobRepositoryIdentity(b)).toBe("kaiser1x/test2-codebase");

    const { store } = memoryStorage();
    addRemovedRepo(jobRepositoryIdentity(a)!, store);
    const hidden = [a, b].filter((j) => isRepoRemoved(jobRepositoryIdentity(j), store));
    expect(hidden).toHaveLength(2);
  });

  it("a different repository is unaffected by that removal", () => {
    const other = makeJob("job-c", "https://github.com/kaiser1x/ts-js-dummy.git", "kaiser1x/ts-js-dummy");
    const { store } = memoryStorage();
    addRemovedRepo("kaiser1x/test2-codebase", store);
    expect(isRepoRemoved(jobRepositoryIdentity(other), store)).toBe(false);
  });

  it("falls back to the job's own repoUrl identity for legacy jobs", () => {
    const legacy = makeJob("job-l", "https://github.com/kaiser1x/ts-js-dummy.git", "x/y");
    const noResult: LiveJob = { ...legacy, result: null };
    expect(jobRepositoryIdentity(noResult)).toBe("kaiser1x/ts-js-dummy");
  });
});
