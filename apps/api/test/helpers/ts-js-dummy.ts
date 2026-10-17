// Test helper: builds a CodeTwin for the controlled `ts-js-dummy` scenario by
// running the REAL analyzer + source-fact extraction over the checked-in
// fixture repository (fixtures/ts-js-dummy). Also exposes the persisted
// (real) twin of the healthy revision captured from a production-shaped job.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "@hubris/analyzer";
import { buildSourceFacts, toRepoRelative } from "../../src/app";

export const TS_JS_DUMMY_DIR = fileURLToPath(new URL("../../../../fixtures/ts-js-dummy", import.meta.url));

export interface TwinInput {
  functions: any[];
  tests: any[];
  relationships: any[];
  sourceFacts: any[];
}

// A concrete report: current behavior, expected behavior, constraints.
export const REPORT_CLEAN =
  "Bug: `createPayment()` in `src/payments.ts` accepts a duplicate idempotency key.\n\n" +
  "Current behavior: Calling `createPayment()` a second time with an idempotency key that was already used successfully creates another payment.\n\n" +
  "Expected behavior: The second call must throw an error containing the existing text `duplicate payment for key` and must not create another payment.\n\n" +
  "Keep first-time payments working normally. Preserve the existing function signature, error messages, and unrelated behavior.";

// A report that mixes the bug description with investigation instructions and
// uses "instead of" (the shape that used to be flagged as contradictory).
export const REPORT_WITH_INSTRUCTIONS =
  "A customer retries a payment request using an idempotency key that was already used, but the system processes the payment again instead of rejecting the duplicate. " +
  "Investigate why `createPayment` in `src/payments.ts` allows repeated idempotency keys. Trace the relevant code path, examine the existing tests, and identify the most likely root cause. " +
  'The expected behavior is to reject the duplicate request while preserving the existing error message containing "duplicate payment for key".';

export async function analyzeFixtureTwin(dir: string = TS_JS_DUMMY_DIR): Promise<TwinInput> {
  const twin = await analyzeRepository(dir);
  const sourceFacts = buildSourceFacts(dir, twin);
  for (const fn of twin.functions) fn.path = toRepoRelative(dir, fn.path);
  for (const c of twin.classes) c.path = toRepoRelative(dir, c.path);
  for (const e of twin.endpoints) e.file = toRepoRelative(dir, e.file);
  for (const t of twin.tests) {
    t.path = toRepoRelative(dir, t.path);
    t.file = toRepoRelative(dir, t.file);
  }
  for (const r of twin.relationships) r.from = toRepoRelative(dir, r.from);
  return {
    functions: twin.functions,
    tests: twin.tests,
    relationships: twin.relationships,
    sourceFacts,
  };
}

// The REAL persisted twin of kaiser1x/ts-js-dummy @ main (healthy revision).
export function persistedHealthyTwin(): { commitSha: string; scripts: Record<string, string>; twin: TwinInput } {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/ts-js-dummy/healthy-twin.json", import.meta.url)), "utf8")
  );
  return {
    commitSha: raw.commitSha,
    scripts: raw.scripts,
    twin: {
      functions: raw.full.functions,
      tests: raw.full.tests,
      relationships: raw.full.relationships,
      sourceFacts: raw.full.sourceFacts,
    },
  };
}

function persistedTwin(file: string): { commitSha: string; scripts: Record<string, string>; twin: TwinInput } {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/ts-js-dummy/${file}`, import.meta.url)), "utf8"));
  return {
    commitSha: raw.commitSha,
    scripts: raw.scripts,
    twin: {
      functions: raw.full.functions,
      tests: raw.full.tests,
      relationships: raw.full.relationships,
      sourceFacts: raw.full.sourceFacts,
    },
  };
}

// The REAL persisted twin of kaiser1x/ts-js-dummy @ hubris/buggy-idempotency
// (job 051683d2): the idempotency guard was dropped, keys are only recorded.
export function persistedBuggyTwin() {
  return persistedTwin("buggy-twin.json");
}

// The saved investigation output that exposed the contract-quality defects.
export function savedDefectiveInvestigation(): {
  focus: string;
  expectedBehavior: string;
  repairContract: Record<string, any>;
} {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../fixtures/ts-js-dummy/saved-investigation-2026-10-16.json", import.meta.url)),
      "utf8"
    )
  );
}
