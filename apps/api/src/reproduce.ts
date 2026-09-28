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
//   REPRODUCED        repro ran and exited non-zero (the reported failure)
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
  | "TIMEOUT";

export interface ReproClassification {
  outcome: ReproOutcome;
  reason: string;
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

// Classify a finished sandbox run. Never throws; malformed shapes degrade
// to SETUP_FAILED rather than claiming a reproduction.
export function classifyReproduction(input: {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): ReproClassification {
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
  return { outcome: "REPRODUCED", reason: "Failure reproduced in isolated sandbox." };
}
