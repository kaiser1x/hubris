// Forge history presentation tests. Pure rendering: no sandbox, no network.
// The panel must stay bounded regardless of how many runs exist, keep the
// full transcript out of the main page, and route to /history.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ForgeHistoryPanel from "../app/components/ForgeHistoryPanel";
import ForgeRunDrawer from "../app/components/ForgeRunDrawer";
import {
  RECENT_RUNS_LIMIT,
  formatRunTime,
  shortRunStatus,
  toForgeHistoryRow,
  type ForgeRunView,
} from "../app/lib/forge-run";

function makeRun(number: number, over: Record<string, unknown> = {}): ForgeRunView {
  return {
    id: `run-${number}`,
    investigationId: null,
    number,
    kind: "structured",
    status: over.status === undefined ? "VERIFIED" : String(over.status),
    outcome: (over.outcome as ForgeRunView["outcome"]) ?? "VERIFIED",
    steps: [],
    modelSource: "forge",
    focus: "Restore the duplicate-key guard",
    edits: [{ path: "src/payments.ts", function: "createPayment" }],
    editChecks: [],
    patchBytes: 510,
    patchShaShort: "a".repeat(12) + "…",
    applyApplied: true,
    mismatch: null,
    source: { ref: "hubris/buggy-idempotency", refSource: "job", commitSha: null, analysisCommitSha: null, executionCommitSha: null, sandboxRef: null, sandboxSha: null, sandboxMatched: true },
    sandbox: { image: "tag:node:20-slim", manager: "pnpm", files: 16, durationMs: 15636 },
    sandboxChecks: [],
    verification: { command: "pnpm test", exitCode: 0, timedOut: false, passed: true, started: true, result: "PASS", assessment: null },
    testSummary: { passed: 13, total: 13 },
    outputTail: [],
    errorTail: [],
    at: "2026-09-26T18:40:00.000Z",
    ...over,
  };
}

describe("toForgeHistoryRow / helpers", () => {
  it("maps a run to a compact row and short status labels", () => {
    const row = toForgeHistoryRow(makeRun(19));
    expect(row).toMatchObject({ id: "run-19", status: "VERIFIED", target: "createPayment", summary: "13/13" });
    expect(shortRunStatus(makeRun(1, { outcome: "VERIFICATION_FAILED" }))).toBe("FAILED");
    expect(shortRunStatus(makeRun(2, { outcome: "UNKNOWN", status: "FAILED" }))).toBe("FAILED");
  });

  it("formats ISO timestamps as local time and degrades gracefully", () => {
    expect(formatRunTime("2026-09-26T18:40:00.000Z")).not.toBe("—");
    expect(formatRunTime(null)).toBe("—");
    expect(formatRunTime("nope")).toBe("—");
  });
});

describe("ForgeHistoryPanel", () => {
  it("shows only the newest runs no matter how many exist", () => {
    const runs = Array.from({ length: 12 }, (_, i) => makeRun(i + 1));
    const html = renderToStaticMarkup(
      <ForgeHistoryPanel
        runs={runs}
        runsJob="job · src: ref"
        runsChecked
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    const count = (html.match(/aria-label="Open run #/g) ?? []).length;
    expect(count).toBe(RECENT_RUNS_LIMIT);
    expect(count).toBe(3);
    expect(html).toContain("12 total");
  });

  it("keeps full transcripts off the main page and links to history", () => {
    const html = renderToStaticMarkup(
      <ForgeHistoryPanel
        runs={[makeRun(1), makeRun(2), makeRun(3)]}
        runsJob={null}
        runsChecked
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(html).toContain('href="/history"');
    expect(html).not.toContain("Run sequence");
    expect(html).not.toContain("Model output");
    expect(html).not.toContain("Source revision");
  });

  it("renders empty and loading states", () => {
    const loading = renderToStaticMarkup(
      <ForgeHistoryPanel runs={[]} runsJob={null} runsChecked={false} onRefresh={vi.fn()} onSelect={vi.fn()} />
    );
    expect(loading).toContain("Loading persisted Forge runs");
    const empty = renderToStaticMarkup(
      <ForgeHistoryPanel runs={[]} runsJob={null} runsChecked onRefresh={vi.fn()} onSelect={vi.fn()} />
    );
    expect(empty).toContain("No Forge runs yet");
  });
});

describe("ForgeRunDrawer", () => {
  it("renders nothing without a selected run", () => {
    expect(renderToStaticMarkup(<ForgeRunDrawer run={null} onClose={vi.fn()} />)).toBe("");
  });

  it("shows the full transcript for a selected run with accessible close", () => {
    const html = renderToStaticMarkup(<ForgeRunDrawer run={makeRun(17, { outcome: "VERIFICATION_FAILED" })} onClose={vi.fn()} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Run sequence");
    expect(html).toContain("Model output");
    expect(html).toContain("Source revision");
    expect(html).toContain("Historical run");
    expect(html).toContain("CLOSE");
  });
});