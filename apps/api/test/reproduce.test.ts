// Reproduce staging/classification tests. Pure: no sandbox, no network.
// The script builder reuses the install pipeline, and classification maps
// a failing reproduction to REPRODUCED rather than an infrastructure error.
import { describe, it, expect } from "vitest";
import {
  buildReproScript,
  buildVerifyScript,
  classifyReproduction,
  classifyVerification,
  REPRO_BEGIN_MARKER,
  VERIFY_EXECUTION_BEGIN_MARKER,
} from "../src/reproduce";

describe("buildReproScript", () => {
  it("stages, installs with scripts disabled, marks the phase, then runs the repro", () => {
    const cmd = buildReproScript("pnpm", [], "pnpm exec vitest run tests/x.test.ts");
    expect(cmd).toContain("tar -xf");
    expect(cmd).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(cmd).toContain(`echo ${REPRO_BEGIN_MARKER}`);
    expect(cmd).toContain("pnpm exec vitest run tests/x.test.ts");
    expect(cmd.indexOf(REPRO_BEGIN_MARKER)).toBeLessThan(cmd.indexOf("pnpm exec"));
  });

  it("honors npm and drops secret-adjacent tracked files", () => {
    const cmd = buildReproScript("npm", [".env"], "npm test");
    expect(cmd).toContain("npm ci --ignore-scripts");
    expect(cmd).toContain("rm -f '.env'");
    expect(cmd).toContain("npm test");
  });
});

describe("classifyReproduction", () => {
  it("known failing regression -> REPRODUCED", () => {
    const r = classifyReproduction({
      exitCode: 1,
      timedOut: false,
      stdout: `test file | 1 failed\n${REPRO_BEGIN_MARKER}\n ✗ rejects a previously seen key`,
      stderr: "",
    });
    expect(r.outcome).toBe("REPRODUCED");
  });

  it("passing repro command -> NOT_REPRODUCED", () => {
    const r = classifyReproduction({ exitCode: 0, timedOut: false, stdout: `${REPRO_BEGIN_MARKER}\nok`, stderr: "" });
    expect(r.outcome).toBe("NOT_REPRODUCED");
  });

  it("missing install phase -> SETUP_FAILED", () => {
    const r = classifyReproduction({ exitCode: 1, timedOut: false, stdout: "ERR_PNPM", stderr: "corepack error" });
    expect(r.outcome).toBe("SETUP_FAILED");
  });

  it("command not found after provisioning -> EXECUTION_FAILED", () => {
    const r = classifyReproduction({
      exitCode: 127,
      timedOut: false,
      stdout: `${REPRO_BEGIN_MARKER}`,
      stderr: "/bin/sh: pnpm: not found",
    });
    expect(r.outcome).toBe("EXECUTION_FAILED");
  });

  it("timeout -> TIMEOUT", () => {
    const r = classifyReproduction({ exitCode: null, timedOut: true, stdout: "", stderr: "" });
    expect(r.outcome).toBe("TIMEOUT");
  });
});

describe("buildVerifyScript", () => {
  it("records setup and execution markers around the actual command", () => {
    const command = buildVerifyScript("pnpm", [], "pnpm test -- tests/users.test.ts");
    expect(command).toContain(`echo ${REPRO_BEGIN_MARKER}`);
    expect(command).toContain(`echo ${VERIFY_EXECUTION_BEGIN_MARKER}`);
    expect(command).toContain("pnpm test -- tests/users.test.ts");
    expect(command.indexOf(REPRO_BEGIN_MARKER)).toBeLessThan(command.indexOf(VERIFY_EXECUTION_BEGIN_MARKER));
  });
});

describe("classifyVerification", () => {
  it("keeps setup failure separate from test failure", () => {
    const result = classifyVerification({ setupRequired: true, exitCode: 127, timedOut: false, stdout: "install failed", stderr: "pnpm: not found" });
    expect(result).toMatchObject({ setupStatus: "FAILED", executionStatus: "NOT_STARTED", result: "SETUP_FAILED", passed: false });
  });

  it("reports command-not-found after setup as execution failure", () => {
    const result = classifyVerification({ setupRequired: true, exitCode: 127, timedOut: false, stdout: `${REPRO_BEGIN_MARKER}\n${VERIFY_EXECUTION_BEGIN_MARKER}`, stderr: "tool: not found" });
    expect(result).toMatchObject({ setupStatus: "SUCCEEDED", executionStatus: "COMMAND_NOT_FOUND", result: "COMMAND_NOT_FOUND" });
  });

  it("distinguishes a passing and failing executed command", () => {
    const pass = classifyVerification({ setupRequired: false, exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    const fail = classifyVerification({ setupRequired: false, exitCode: 1, timedOut: false, stdout: "", stderr: "" });
    expect(pass.result).toBe("PASS");
    expect(fail.result).toBe("TEST_FAILED");
  });
});
