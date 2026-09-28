import type { LiveJob } from "./live-twin";
import type { ReadyInvestigationView } from "./forge-run";

export interface ReproductionSuggestion {
  command: string;
  reason: string;
}

export type TestRunner = "vitest" | "jest" | "mocha" | "ava" | "tap";

// Recognize the runner from the repository's own test script. Only runners
// that accept a targeted test-file argument are considered.
export function detectTestRunner(testScript: string): TestRunner | null {
  if (typeof testScript !== "string") return null;
  const s = testScript.toLowerCase();
  if (/\bvitest\b/.test(s)) return "vitest";
  if (/\bjest\b/.test(s)) return "jest";
  if (/\bmocha\b/.test(s)) return "mocha";
  if (/\bava\b/.test(s)) return "ava";
  if (/\btap\b/.test(s)) return "tap";
  return null;
}

// Suggest only when the saved investigation names a real analyzed test file,
// the job records a supported package manager and test script, and the script
// identifies a runner that accepts a targeted file argument. The command is
// derived from actual repository metadata — never assumed.
export function suggestReproduction(
  job: LiveJob,
  investigation: ReadyInvestigationView
): ReproductionSuggestion | null {
  const evidence = investigation.plan.reproduction;
  const result = job.result;
  const manager = result?.packageManager;
  const testScript = result?.scripts?.test;
  if (!evidence || !manager || !testScript) return null;
  const testFile = result.full?.tests.find(
    (test) => test.path === evidence.testFile || test.file === evidence.testFile
  );
  if (!testFile) return null;
  const runner = detectTestRunner(testScript);
  if (!runner) return null;

  // Prefer the runner's own targeted invocation (spec §12): a vitest repo
  // runs `vitest run <file> --reporter=verbose` rather than the whole suite.
  let command: string;
  if (runner === "vitest") {
    command =
      manager === "pnpm"
        ? `pnpm exec vitest run ${evidence.testFile} --reporter=verbose`
        : `npx vitest run ${evidence.testFile} --reporter=verbose`;
  } else if (runner === "jest") {
    command = manager === "pnpm" ? `pnpm exec jest ${evidence.testFile}` : `npx jest ${evidence.testFile}`;
  } else {
    command = `${manager} test -- ${evidence.testFile}`;
  }

  return {
    command,
    reason: `Matches the relevant scenario "${evidence.scenario}" in ${evidence.testFile}.`,
  };
}
