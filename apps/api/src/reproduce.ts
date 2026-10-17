// Phase R — staged reproduction (reuses the Forge/test pipeline setup).
//
// Reproduce is different from Forge verification: it captures evidence of a
// reported FAILURE. The sandbox prepares the repository exactly like the
// install/test pipeline (staged tarball, detected package manager,
// --ignore-scripts install, no host secrets), then runs the user's repro
// script with the manager on PATH. A failing reproduction is the expected
// outcome, not an infrastructure failure — unless the failure happened
// before the repro command could run.
//
// Outcome model:
//   REPRODUCED        repro ran and the investigated scenario failed
//   UNRELATED_FAILURE repro exited non-zero, but not in the investigated scenario
//   NOT_REPRODUCED    repro ran and exited 0
//   SETUP_FAILED      staging/install failed before the repro ran
//   EXECUTION_FAILED  repro could not execute (command not found)
//   TIMEOUT           the run exceeded the configured timeout

import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";

export const REPRO_BEGIN_MARKER = "REPRO_BEGIN";
export const VERIFY_EXECUTION_BEGIN_MARKER = "VERIFY_EXECUTION_BEGIN";

export type ReproOutcome =
  | "REPRODUCED"
  | "NOT_REPRODUCED"
  | "SETUP_FAILED"
  | "EXECUTION_FAILED"
  | "UNRELATED_FAILURE"
  | "TIMEOUT";

export interface ReproClassification {
  outcome: ReproOutcome;
  reason: string;
  // Did the failure demonstrate the investigated behavior? null when the run
  // was not tied to an investigated scenario.
  demonstrated?: boolean | null;
}

export type VerificationResult =
  | "SETUP_FAILED"
  | "COMMAND_NOT_FOUND"
  | "TEST_FAILED"
  | "PASS"
  | "TIMEOUT";

export function classifyVerification(input: {
  setupRequired: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): {
  setupStatus: "NOT_REQUESTED" | "SUCCEEDED" | "FAILED";
  executionStatus: "NOT_STARTED" | "COMMAND_NOT_FOUND" | "COMPLETED" | "TIMEOUT";
  result: VerificationResult;
  passed: boolean;
  exitCode: number | null;
} {
  const setupComplete = !input.setupRequired || input.stdout.includes(REPRO_BEGIN_MARKER);
  const executionStarted = !input.setupRequired || input.stdout.includes(VERIFY_EXECUTION_BEGIN_MARKER);
  if (!setupComplete) {
    return { setupStatus: "FAILED", executionStatus: "NOT_STARTED", result: "SETUP_FAILED", passed: false, exitCode: null };
  }
  if (!executionStarted) {
    return { setupStatus: "SUCCEEDED", executionStatus: "NOT_STARTED", result: "SETUP_FAILED", passed: false, exitCode: null };
  }
  if (input.timedOut) {
    return { setupStatus: input.setupRequired ? "SUCCEEDED" : "NOT_REQUESTED", executionStatus: "TIMEOUT", result: "TIMEOUT", passed: false, exitCode: input.exitCode };
  }
  if (input.exitCode === 127 || /(command )?not found/i.test(input.stderr)) {
    return { setupStatus: input.setupRequired ? "SUCCEEDED" : "NOT_REQUESTED", executionStatus: "COMMAND_NOT_FOUND", result: "COMMAND_NOT_FOUND", passed: false, exitCode: input.exitCode };
  }
  return {
    setupStatus: input.setupRequired ? "SUCCEEDED" : "NOT_REQUESTED",
    executionStatus: "COMPLETED",
    result: input.exitCode === 0 ? "PASS" : "TEST_FAILED",
    passed: input.exitCode === 0,
    exitCode: input.exitCode,
  };
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Extract, install (with lifecycle scripts disabled, same as install/test),
// then run the repro invocation. The marker separates the install phase
// (absent) from the reproduction phase (present) in captured stdout, so a
// non-zero exit after the marker is a reproduced failure, not a setup issue.
export function buildReproScript(
  manager: PackageManager,
  excluded: string[],
  invoke: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `${INSTALL_COMMANDS[manager]}; echo ${REPRO_BEGIN_MARKER}; ${invoke}`
  );
}

export function buildVerifyScript(
  manager: PackageManager,
  excluded: string[],
  invoke: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `${INSTALL_COMMANDS[manager]}; echo ${REPRO_BEGIN_MARKER}; ` +
    `echo ${VERIFY_EXECUTION_BEGIN_MARKER}; ${invoke}`
  );
}

// What the investigation says the reported behavior is, as observable in a
// test run: the scenario it named and the file that holds it.
export interface ReproExpectation {
  scenario?: string | null;
  testFile?: string | null;
}

// Failures of the RUNNER or the module graph, not of a scenario's assertions.
const RUNNER_ERROR_PATTERN =
  /no test files? found|no tests? found|cannot find module|err_module_not_found|syntaxerror|failed to load|transform failed|unexpected token|command not found/i;

// A line that reports a failing test (vitest/jest): FAIL header, a failure
// glyph, or a numbered jest failure entry.
const FAILING_LINE_PATTERN = /^\s*(?:FAIL\b|[×✗✕❌❯]|\d+\)\s)/;

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Does the output show the investigated scenario (or, absent a scenario, its
// test file) FAILING? A scenario that merely appears in a passing line, or a
// failure in some other test, does not count.
function outputShowsFailure(output: string, expected: ReproExpectation): boolean {
  const scenario = expected.scenario ? normalizeForMatch(expected.scenario) : "";
  const file = expected.testFile ? normalizeForMatch(expected.testFile) : "";
  for (const line of output.split("\n")) {
    if (!FAILING_LINE_PATTERN.test(line)) continue;
    const text = normalizeForMatch(line);
    if (scenario) {
      if (text.includes(scenario)) return true;
    } else if (file && text.includes(file)) {
      return true;
    }
  }
  return false;
}

// Classify a finished sandbox run. Never throws; malformed shapes degrade
// to SETUP_FAILED rather than claiming a reproduction.
//
// With an investigation context (`expected`), a non-zero exit is REPRODUCED
// only when the investigated scenario is the thing that failed. Any other
// failure — a different test, a runner error, "no test files found" — proves
// nothing about the reported behavior. Without a context the failure cannot
// be tied to the report and is flagged as such (`demonstrated: null`).
export function classifyReproduction(
  input: {
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
  expected?: ReproExpectation | null
): ReproClassification {
  if (input.timedOut) {
    return { outcome: "TIMEOUT", reason: "Reproduction exceeded the configured timeout." };
  }
  if (!input.stdout.includes(REPRO_BEGIN_MARKER)) {
    return {
      outcome: "SETUP_FAILED",
      reason: "Sandbox could not be prepared: staging or dependency installation failed before the reproduction command ran.",
    };
  }
  if (input.exitCode === 127 || /(command )?not found/i.test(input.stderr)) {
    return {
      outcome: "EXECUTION_FAILED",
      reason: "Reproduction command failed to execute (command not found).",
    };
  }
  if (input.exitCode === 0) {
    return { outcome: "NOT_REPRODUCED", reason: "Script completed, but the reported failure was not observed." };
  }
  const hasContext = Boolean(expected && (expected.scenario || expected.testFile));
  if (!hasContext) {
    return {
      outcome: "REPRODUCED",
      reason: "The command failed in the isolated sandbox, but it is not tied to an investigated scenario.",
      demonstrated: null,
    };
  }
  const output = `${input.stdout}\n${input.stderr}`;
  if (outputShowsFailure(output, expected as ReproExpectation)) {
    return { outcome: "REPRODUCED", reason: "The investigated scenario failed in the isolated sandbox.", demonstrated: true };
  }
  if (RUNNER_ERROR_PATTERN.test(output)) {
    return {
      outcome: "EXECUTION_FAILED",
      reason: "The test runner could not run the investigated scenario (no test ran or a module failed to load).",
      demonstrated: false,
    };
  }
  return {
    outcome: "UNRELATED_FAILURE",
    reason: "The command failed, but the failure is not the investigated scenario, so it does not demonstrate the reported behavior.",
    demonstrated: false,
  };
}
