import { describe, expect, it } from "vitest";
import { buildHistoryEntries } from "../app/lib/history";

const job = {
  id: "job-history",
  repoUrl: "https://github.com/example/repo.git",
  status: "complete",
  result: {
    repository: { id: "repo", name: "example/repo", analysisStatus: "complete" },
    investigationRuns: [{ investigationId: "inv-1", status: "READY", createdAt: "2026-09-26T10:00:00.000Z", focus: "Duplicate payments on retry", plan: { target: { file: "src/payments.ts", function: "createPayment" } } }],
    forgeRuns: [{ id: "forge-1", status: "VERIFIED", at: "2026-09-26T11:00:00.000Z", history: [{ state: "VERIFIED" }], generation: { source: "forge", format: "structured-edit", focus: "Repair duplicate payments", edits: [{ path: "src/payments.ts", function: "createPayment" }] }, apply: { applied: true }, verification: { command: "pnpm test", exitCode: 0, timedOut: false, passed: true }, verified: true }],
    stats: { functions: 1, classes: 0, endpoints: 1, tests: 1, relationships: 1 },
  },
  error: null,
};

describe("history view model", () => {
  it("surfaces persisted investigation and Forge records", () => {
    const entries = buildHistoryEntries([job] as never);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toEqual(["forge", "investigation"]);
    expect(entries.find((entry) => entry.kind === "investigation")?.target).toContain("createPayment");
    expect(entries.find((entry) => entry.kind === "forge")?.verification).toContain("PASS");
  });

  it("preserves the investigation identity in its open link", () => {
    const investigation = buildHistoryEntries([job] as never).find((entry) => entry.kind === "investigation");
    expect(investigation?.href).toContain("investigationId=inv-1");
    expect(investigation?.href).toContain("jobId=job-history");
  });

  it("does not invent records for empty persisted data", () => {
    expect(buildHistoryEntries([])).toEqual([]);
    expect(buildHistoryEntries([{ ...job, result: { stats: job.result.stats } }] as never)).toEqual([]);
  });

  it("renders the real repository identity of each job", () => {
    const b = {
      ...job,
      id: "job-b",
      repoUrl: "https://github.com/kaiser1x/test2-codebase.git",
      result: {
        ...job.result,
        repository: { id: "r2", name: "kaiser1x/test2-codebase", analysisStatus: "complete" },
      },
    };
    const entries = buildHistoryEntries([job, b] as never);
    const repos = new Set(entries.map((entry) => entry.repository));
    expect(repos.has("example/repo")).toBe(true);
    expect(repos.has("kaiser1x/test2-codebase")).toBe(true);
    expect(repos.has("kaiser1x/ts-js-dummy")).toBe(false);
  });

  it("labels jobs without any derivable identity explicitly, never a demo fallback", () => {
    const legacy = {
      ...job,
      id: "job-legacy",
      repoUrl: "",
      result: {
        investigationRuns: [{ investigationId: "inv-legacy", status: "READY", createdAt: "2026-09-26T10:00:00.000Z", focus: "A bug report", plan: { target: { file: "src/a.ts", function: "run" } } }],
      },
    };
    const entries = buildHistoryEntries([legacy] as never);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.repository === "Repository context unavailable")).toBe(true);
    expect(entries.every((entry) => !entry.repository.includes("ts-js-dummy"))).toBe(true);
  });
});
