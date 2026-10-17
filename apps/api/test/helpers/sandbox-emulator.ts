// Test double for the disposable sandbox. It runs the REAL structured-edit
// validator (VALIDATOR_JS) and REAL `git diff` over a throwaway copy of the
// analyzed repository, then reports exactly the markers the production script
// would print. Only test execution (install / vitest) is simulated, by an
// injected "oracle" that inspects the actual edited working tree — so a
// verification result always reflects the code the edit really produced.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STRUCTURED_UPLOAD_EDITS, STRUCTURED_UPLOAD_VALIDATOR, VALIDATOR_JS } from "../../src/structured";

export interface ExecOutcome {
  exitCode: number;
  output: string;
}

export interface SandboxOracle {
  // Run the user's reproduction command against the UNMODIFIED analyzed tree.
  reproduce(script: string, workDir: string): ExecOutcome;
  // The targeted run of the investigated scenario against the EDITED tree.
  target(workDir: string): ExecOutcome;
  // The full regression suite against the EDITED tree.
  suite(workDir: string): ExecOutcome;
}

export interface EmulatorRun {
  kind: "reproduce" | "structured";
  command: string;
}

export function createSandboxEmulator(repoDir: string, oracle: SandboxOracle) {
  const uploads = new Map<string, Uint8Array>();
  const runs: EmulatorRun[] = [];
  const workDirs: string[] = [];

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

  function copyRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-sbx-"));
    fs.cpSync(repoDir, dir, { recursive: true });
    workDirs.push(dir);
    return dir;
  }

  function uploaded(uuid: string | undefined): Uint8Array {
    const bytes = uuid ? uploads.get(uuid) : undefined;
    if (!bytes) throw new Error("emulator: unknown upload");
    return bytes;
  }

  return {
    uploads,
    runs,
    cleanup() {
      for (const d of workDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    },

    async uploadFile(_config: unknown, content: Uint8Array) {
      const uuid = randomUUID();
      uploads.set(uuid, content);
      return { uuid, sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
    },

    async runCommand(_config: unknown, req: { command: string; files?: Record<string, { uuid: string }> }) {
      const command = req.command;
      if (command.includes("canonical.patch")) {
        runs.push({ kind: "structured", command });
        const work = copyRepo();
        const validator = path.join(work, "..", `validator-${randomUUID()}.js`);
        const edits = path.join(work, "..", `edits-${randomUUID()}.json`);
        fs.writeFileSync(validator, Buffer.from(uploaded(req.files?.[STRUCTURED_UPLOAD_VALIDATOR]?.uuid)));
        fs.writeFileSync(edits, Buffer.from(uploaded(req.files?.[STRUCTURED_UPLOAD_EDITS]?.uuid)));
        // Sanity: the production validator source is what runs.
        if (fs.readFileSync(validator, "utf8") !== VALIDATOR_JS) throw new Error("emulator: validator mismatch");
        let validatorOut = "";
        try {
          validatorOut = execFileSync("node", [validator, work, edits], { encoding: "utf8" });
        } catch (error: any) {
          return { exitCode: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: "", timedOut: false };
        } finally {
          fs.rmSync(validator, { force: true });
          fs.rmSync(edits, { force: true });
        }
        const patch = git(work, "diff");
        const sha = createHash("sha256").update(patch).digest("hex");
        const bytes = Buffer.byteLength(patch, "utf8");
        const ref = command.match(/echo SOURCE_REF '([^']*)'/)?.[1] ?? "";
        const sourceSha = command.match(/echo SOURCE_SHA '([^']*)'/)?.[1] ?? "";
        let patchOk = true;
        try {
          git(work, "diff", "--check");
        } catch {
          patchOk = false;
        }
        let stdout = validatorOut;
        stdout += `CANONICAL_SHA ${sha} ${bytes}\n`;
        stdout += `CANONICAL_B64 ${Buffer.from(patch, "utf8").toString("base64")}\n`;
        stdout += `SOURCE_REF ${ref}\nSOURCE_SHA ${sourceSha}\n`;
        if (patchOk) stdout += "PATCH_OK\n";
        stdout += "VERIFY_BEGIN\n";
        if (command.includes("TARGET_EXIT")) {
          const target = oracle.target(work);
          stdout += `${target.output}\nTARGET_VERIFY_DONE ${target.exitCode}\n`;
        }
        const suite = oracle.suite(work);
        stdout += `${suite.output}\n`;
        return { exitCode: suite.exitCode, stdout, stderr: "", timedOut: false };
      }

      if (command.includes("REPRO_BEGIN")) {
        runs.push({ kind: "reproduce", command });
        const invoke = command.split("echo REPRO_BEGIN; ")[1] ?? "";
        const work = copyRepo();
        const out = oracle.reproduce(invoke, work);
        return { exitCode: out.exitCode, stdout: `REPRO_BEGIN\n${out.output}\n`, stderr: "", timedOut: false };
      }
      throw new Error(`emulator: unexpected sandbox command: ${command.slice(0, 80)}`);
    },
  };
}

// A throwaway git repository holding a copy of a source tree, committed with
// byte-exact line endings. Returns its path and the tracked file list.
export function makeGitRepo(sourceDir: string, extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-e2e-repo-"));
  fs.cpSync(sourceDir, dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  for (const [rel, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), content);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  run("init", "-q");
  run("add", "-A");
  run("commit", "-qm", "base");
  const tracked = run("ls-files").split("\n").filter(Boolean);
  return { dir, tracked, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
