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


// A failing command is evidence of the REPORTED bug only when the failure is
// the investigated scenario. Any other non-zero exit proves nothing about it.
describe("classifyReproduction grounded in the investigated scenario", () => {
  const EXPECT = {
    scenario: "rejects a previously seen idempotency key",
    testFile: "tests/idempotency-regression.test.ts",
  };
  const out = (body: string) => `${REPRO_BEGIN_MARKER}\n${body}`;

  it("the investigated scenario failing -> REPRODUCED", () => {
    const r = classifyReproduction(
      {
        exitCode: 1,
        timedOut: false,
        stdout: out(
          [
            " FAIL  tests/idempotency-regression.test.ts > idempotency regression (buggy fixture) > rejects a previously seen idempotency key",
            "AssertionError: expected function to throw an error, but it didn't",
          ].join("\n")
        ),
        stderr: "",
      },
      EXPECT
    );
    expect(r.outcome).toBe("REPRODUCED");
    expect(r.demonstrated).toBe(true);
  });

  it("verbose runner marker for the scenario -> REPRODUCED", () => {
    const r = classifyReproduction(
      {
        exitCode: 1,
        timedOut: false,
        stdout: out(" × idempotency regression (buggy fixture) > rejects a previously seen idempotency key 3ms"),
        stderr: "",
      },
      EXPECT
    );
    expect(r.outcome).toBe("REPRODUCED");
  });

  it("a DIFFERENT test failing does not reproduce the report", () => {
    const r = classifyReproduction(
      {
        exitCode: 1,
        timedOut: false,
        stdout: out(" FAIL  tests/users.test.ts > users > finds a seeded user\nAssertionError: expected 'x' to be 'Ada'"),
        stderr: "",
      },
      EXPECT
    );
    expect(r.outcome).toBe("UNRELATED_FAILURE");
    expect(r.demonstrated).toBe(false);
    expect(r.reason).toMatch(/not the investigated scenario/i);
  });

  it("the scenario passing while the run still exits non-zero is not a reproduction", () => {
    const r = classifyReproduction(
      {
        exitCode: 1,
        timedOut: false,
        stdout: out(
          " ✓ idempotency regression (buggy fixture) > rejects a previously seen idempotency key 2ms\n FAIL  tests/other.test.ts > other > breaks"
        ),
        stderr: "",
      },
      EXPECT
    );
    expect(r.outcome).toBe("UNRELATED_FAILURE");
  });

  it("'No test files found' / module errors are an execution failure, never a reproduction", () => {
    for (const body of [
      "No test files found, exiting with code 1\nfilter: tests/idempotency-regression.test.ts",
      "Error: Cannot find module '../src/payments.js'",
      "SyntaxError: Unexpected token '}'",
    ]) {
      const r = classifyReproduction({ exitCode: 1, timedOut: false, stdout: out(body), stderr: "" }, EXPECT);
      expect(r.outcome, body).toBe("EXECUTION_FAILED");
      expect(r.demonstrated).toBe(false);
    }
  });

  it("a passing run is still NOT_REPRODUCED, a timeout still TIMEOUT, missing setup still SETUP_FAILED", () => {
    expect(classifyReproduction({ exitCode: 0, timedOut: false, stdout: out("ok"), stderr: "" }, EXPECT).outcome).toBe("NOT_REPRODUCED");
    expect(classifyReproduction({ exitCode: null, timedOut: true, stdout: "", stderr: "" }, EXPECT).outcome).toBe("TIMEOUT");
    expect(classifyReproduction({ exitCode: 1, timedOut: false, stdout: "ERR_PNPM", stderr: "" }, EXPECT).outcome).toBe("SETUP_FAILED");
  });

  it("without investigation context a failure is still reported, but flagged as not tied to the report", () => {
    const r = classifyReproduction({ exitCode: 1, timedOut: false, stdout: out("boom"), stderr: "" });
    expect(r.outcome).toBe("REPRODUCED");
    expect(r.demonstrated).toBeNull();
    expect(r.reason).toMatch(/not tied to an investigated scenario/i);
  });

  it("matches only the test file when the investigation named no scenario", () => {
    const fileOnly = { scenario: null, testFile: "tests/idempotency-regression.test.ts" };
    const hit = classifyReproduction(
      { exitCode: 1, timedOut: false, stdout: out(" FAIL  tests/idempotency-regression.test.ts > a > b"), stderr: "" },
      fileOnly
    );
    expect(hit.outcome).toBe("REPRODUCED");
    const miss = classifyReproduction(
      { exitCode: 1, timedOut: false, stdout: out(" FAIL  tests/users.test.ts > a > b"), stderr: "" },
      fileOnly
    );
    expect(miss.outcome).toBe("UNRELATED_FAILURE");
  });
});
