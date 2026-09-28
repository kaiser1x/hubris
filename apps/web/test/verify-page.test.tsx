import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The standalone Verify page is BASELINE verification against the analyzed
// source revision. It must not imply it verifies a Forge patch, and it must
// point to the real post-Forge verification (the Forge run) rather than
// pretending to be one.
describe("Verify page is baseline verification only", () => {
  const PAGE = fileURLToPath(
    new URL("../app/(workspace)/verify/page.tsx", import.meta.url)
  );
  const source = readFileSync(PAGE, "utf8");

  it("identifies itself as baseline verification against the analyzed revision", () => {
    expect(source).toContain("Baseline verification");
    expect(source).toContain("Checks run against the analyzed source revision");
    expect(source).toMatch(/Forge changes are not\s+applied\./);
  });

  it("does not present itself as a repair verification", () => {
    expect(source).not.toContain("Verification record");
    expect(source).not.toContain("REPAIR VERIFIED");
    expect(source).not.toContain("repair verified");
    // It never claims to verify an applied patch itself.
    expect(source).not.toMatch(/\bverif(?:y|ies) (?:the )?(?:applied )?(?:Forge )?patch\b/i);
  });

  it("labels the command and results as baseline, not generic verification", () => {
    expect(source).toContain("Baseline check command");
    expect(source).toContain("RUN BASELINE CHECK");
    expect(source).not.toContain("Verification command");
  });

  it("points to the real post-Forge verification flow separately", () => {
    expect(source).toContain("Verify applied repair");
    expect(source).toContain("GO TO FORGE");
    expect(source).toContain("baseline checks passing");
  });
});
