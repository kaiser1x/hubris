import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The repository selector's "Remove from HUBRIS" action is presentational only:
// it hides a repository from the selector and NEVER touches GitHub.
describe("WorkspaceSwitcher removal UX", () => {
  const SWITCHER = fileURLToPath(
    new URL("../app/components/WorkspaceSwitcher.tsx", import.meta.url)
  );
  const WORKSPACE = fileURLToPath(new URL("../app/lib/workspace.ts", import.meta.url));
  const source = readFileSync(SWITCHER, "utf8");
  const lib = readFileSync(WORKSPACE, "utf8");

  it("offers a clearly labelled, HUBRIS-scoped action", () => {
    expect(source).toContain("REMOVE FROM HUBRIS");
    expect(source).toContain("OPEN");
  });

  it("requires explicit confirmation with the exact safe copy", () => {
    expect(source).toContain("from HUBRIS?");
    expect(source).toContain("This only removes the repository from your HUBRIS workspace.");
    expect(source).toContain("The GitHub repository");
    expect(source).toContain("will not be changed.");
    expect(source).toContain("CANCEL");
    // Removal happens only from the confirm handler, never directly from the
    // initial REMOVE button.
    expect(source).toContain("setConfirming(true)");
    expect(source).toContain("confirmRemove");
  });

  it("offers undo after removal", () => {
    expect(source).toContain("Repository removed from HUBRIS.");
    expect(source).toContain("UNDO");
    expect(source).toContain("removeRemovedRepo");
  });

  it("clears the active repository and returns to the Codebase page", () => {
    expect(source).toContain("selectJob(null)");
    expect(source).toContain('router.replace("/codebase")');
  });

  it("groups duplicate jobs by canonical identity", () => {
    expect(source).toContain("jobRepositoryIdentity");
    expect(source).toContain("removed.includes(identity)");
  });

  it("never uses destructive repository wording", () => {
    expect(source).not.toContain("Delete repository");
    expect(source).not.toContain("Delete repo");
    expect(source).not.toContain("Remove repository from GitHub");
  });

  it("contains no GitHub mutation surface (no DELETE/archive, no fetch)", () => {
    for (const needle of ["api.github.com", "/git/refs", "DELETE", "archive"]) {
      expect(source).not.toContain(needle);
      expect(lib).not.toContain(needle);
    }
    // The persistence layer performs no network I/O at all.
    expect(lib).not.toContain("fetch(");
  });
});
