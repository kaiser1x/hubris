import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// SHIP is bound to the EXACT Forge run the user reviewed. It must never fall
// back to the latest or first-eligible run, and it must not create a second
// patch — it consumes the persisted canonical patch.
describe("SHIP page binds the exact Forge run", () => {
  const PAGE = fileURLToPath(new URL("../app/(workspace)/ship/page.tsx", import.meta.url));
  const source = readFileSync(PAGE, "utf8");

  it("binds the exact forgeRunId from the URL, with no latest-run fallback", () => {
    expect(source).toContain('searchParams.get("forgeRunId")');
    expect(source).toContain("r.id === requestedRunId");
    expect(source).not.toContain("latestRuns");
    expect(source).not.toContain("withPr ?? eligibleRun");
  });

  it("shows clear messages for a missing or unknown Forge run", () => {
    expect(source).toContain("No Forge run selected");
    expect(source).toContain("Forge run not found on this job.");
    expect(source).not.toContain("NO FORGE RUN YET");
    expect(source).not.toContain("Verify a repair in Forge first");
  });

  it("shows the verified-ready state with full provenance", () => {
    expect(source).toContain("VERIFIED REPAIR READY TO SHIP");
    expect(source).toContain("Target verification");
    expect(source).toContain("Forge run ID");
    expect(source).toContain("Investigation ID");
    expect(source).toContain("Analyzed commit");
    expect(source).toContain("Execution commit");
    expect(source).toContain("Canonical patch SHA");
  });

  it("shows the REAL pull request base, never a hard-coded default branch", () => {
    expect(source).toContain("shipBaseDescription");
    expect(source).toContain("Pull request base");
    expect(source).toContain("Analyzed ref");
    expect(source).not.toContain("<dd>default branch</dd>");
  });

  it("gates PR creation on eligibility and requires confirmation", () => {
    expect(source).toContain("shipEligible");
    // Also disabled in the public demo, where SHIP is refused server-side.
    expect(source).toContain("disabled={!eligibility.eligible || demoMode}");
    expect(source).toContain("CREATE PULL REQUEST?");
    expect(source).toContain("CANCEL");
    expect(source).toContain("SHIP_PATH");
  });

  it("offers no merge action and never creates a second patch", () => {
    expect(source).not.toMatch(/\bMERGE\b/);
    expect(source).not.toContain("mergePullRequest");
    expect(source).toContain("will not merge");
    // Consumes the persisted canonical patch — no Forge/edit generation here.
    expect(source).not.toContain("/api/forge-structured");
    expect(source).not.toContain("buildStructuredPrompt");
    expect(source).not.toContain("composeForgeFocus");
  });
});

// Colour-coded ship status and idempotent-push messaging.
describe("SHIP page status and push handling", () => {
  const PAGE = fileURLToPath(new URL("../app/(workspace)/ship/page.tsx", import.meta.url));
  const source = readFileSync(PAGE, "utf8");

  it("renders colour-coded status for ready / not ready / action required", () => {
    expect(source).toContain("READY FOR PULL REQUEST");
    expect(source).toContain("NOT READY");
    expect(source).toContain("GitHub authorization required");
    // Colour, not text only.
    expect(source).toContain("backgroundColor: gaugeColor");
    expect(source).toContain("borderLeft:");
  });

  it("surfaces the push status and existing-PR outcome", () => {
    expect(source).toContain("Branch is already pushed and matches the verified repair.");
    expect(source).toContain("Verified repair branch was pushed successfully.");
    expect(source).toContain("PULL REQUEST ALREADY EXISTS");
    expect(source).toContain("pushStatus");
    expect(source).toContain("apiState");
    expect(source).toContain("ACTION_REQUIRED");
  });

  it("never pulls or force-pushes in the client", () => {
    expect(source).not.toContain("--force");
    expect(source).not.toContain("git pull");
  });
});
