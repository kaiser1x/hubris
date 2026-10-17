// Runtime git capability diagnostics.
//
// A successful BUILD proves nothing about the deployed function runtime, which
// is a different image from the build container. These checks execute inside
// the running function and exercise exactly what HUBRIS needs from git:
//
//   version     `git --version` runs at all
//   ls-remote   read-only HTTPS access to a PUBLIC repository (clone/fetch need
//               the same transport: git-remote-https, DNS, TLS, egress)
//   temp-repo   os.tmpdir() is writable and `git init`/`add`/`commit` work
//   diff-check  `git diff` yields a patch and `git diff --check` accepts it
//   apply-check `git apply --check`, then `git apply --index` reproduces the
//               patch byte-for-byte via `git diff --cached` (SHIP's own proof)
//   cleanup     the temporary directory is removed
//
// Diagnostics are strictly read-only toward the outside world: no token is
// used, nothing is pushed, no pull request or GitHub resource is created, and
// everything local happens in a throwaway directory under os.tmpdir().
// Output contains step names, durations, and bounded sanitized details only.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  classifyGitError,
  hintFor,
  safeGitDetail,
  type GitFailureCode,
} from "./gitenv";

const execFileAsync = promisify(execFile);

export const DEFAULT_PROBE_REPO = "https://github.com/octocat/Hello-World.git";

export type GitDiagStep = "version" | "ls-remote" | "temp-repo" | "diff-check" | "apply-check" | "cleanup";

export interface GitDiagStepResult {
  step: GitDiagStep;
  ok: boolean;
  ms: number;
  detail?: string;
  code?: GitFailureCode;
  hint?: string;
}

export interface GitDiagReport {
  ok: boolean;
  gitVersion: string | null;
  steps: GitDiagStepResult[];
  at: string;
}

export interface GitDiagDeps {
  exec: (
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (file: string, content: string) => Promise<void>;
  rm: (dir: string) => Promise<void>;
  exists: (p: string) => boolean;
  tmpdir: () => string;
  now: () => number;
}

export const defaultGitDiagDeps: GitDiagDeps = {
  exec: (args, opts) =>
    execFileAsync("git", args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 20_000,
      maxBuffer: 1024 * 1024,
      // Never block on a credential prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  writeFile: (file, content) => fs.promises.writeFile(file, content, "utf-8"),
  rm: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
  exists: (p) => fs.existsSync(p),
  tmpdir: () => os.tmpdir(),
  now: () => Date.now(),
};

// A probe URL must be plain https without credentials: it is a PUBLIC repo read.
export function isSafeProbeUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

export interface GitDiagOptions {
  deps?: GitDiagDeps;
  // Public repository for the read-only ls-remote step. Any git remote that
  // answers `ls-remote HEAD` works (a local path is used by tests).
  probeRepo?: string;
}

const LS_REMOTE_LINE = /^[a-f0-9]{40}\tHEAD$/m;

export async function runGitDiagnostics(options: GitDiagOptions = {}): Promise<GitDiagReport> {
  const deps = options.deps ?? defaultGitDiagDeps;
  const probeRepo = options.probeRepo ?? DEFAULT_PROBE_REPO;
  const steps: GitDiagStepResult[] = [];
  let gitVersion: string | null = null;

  // Runs one step, recording a sanitized result. Returns whether it passed.
  async function step(name: GitDiagStep, run: () => Promise<string | void>): Promise<boolean> {
    const started = deps.now();
    try {
      const detail = await run();
      steps.push({ step: name, ok: true, ms: deps.now() - started, ...(detail ? { detail } : {}) });
      return true;
    } catch (error) {
      const unexpected = error instanceof Error && error.name === "GitDiagAssertion";
      const code = unexpected ? ("GIT_UNEXPECTED_OUTPUT" as const) : classifyGitError(error);
      steps.push({
        step: name,
        ok: false,
        ms: deps.now() - started,
        code,
        detail: safeGitDetail(error),
        hint: hintFor(code),
      });
      return false;
    }
  }
  const assertion = (message: string) => Object.assign(new Error(message), { name: "GitDiagAssertion" });

  // 1. git exists. Nothing else can work without it, so stop here if not.
  const versionOk = await step("version", async () => {
    const { stdout } = await deps.exec(["--version"], { timeoutMs: 5_000 });
    const match = stdout.trim().match(/^git version\s+(\S+)/);
    if (!match) throw assertion("`git --version` did not report a version");
    gitVersion = match[1];
    return `git ${gitVersion}`;
  });

  if (versionOk) {
    // 2. Read-only network access to a PUBLIC repository (no credentials).
    await step("ls-remote", async () => {
      const { stdout } = await deps.exec(["ls-remote", probeRepo, "HEAD"], { timeoutMs: 20_000 });
      if (!LS_REMOTE_LINE.test(stdout)) throw assertion("ls-remote returned no HEAD commit");
      return "HEAD resolved";
    });

    // 3-5. The patch-validation workflow in a throwaway repository.
    let dir: string | null = null;
    const tempOk = await step("temp-repo", async () => {
      dir = await deps.mkdtemp(path.join(deps.tmpdir(), "hubris-gitdiag-"));
      const inRepo = (args: string[]) => deps.exec(args, { cwd: dir ?? undefined, timeoutMs: 15_000 });
      await inRepo(["init", "-q"]);
      await deps.writeFile(path.join(dir, "probe.txt"), "alpha\nbeta\n");
      await inRepo(["add", "probe.txt"]);
      await inRepo(["-c", "user.email=diagnostics@localhost", "-c", "user.name=hubris-diagnostics", "commit", "-qm", "base"]);
      return "init, add, commit";
    });

    if (tempOk && dir) {
      const repo = dir as string;
      const inRepo = (args: string[]) => deps.exec(args, { cwd: repo, timeoutMs: 15_000 });
      let patch = "";
      const diffOk = await step("diff-check", async () => {
        await deps.writeFile(path.join(repo, "probe.txt"), "alpha\nbeta changed\n");
        patch = (await inRepo(["diff"])).stdout;
        if (!patch.includes("+beta changed")) throw assertion("`git diff` did not produce the expected patch");
        await inRepo(["diff", "--check"]);
        return `${Buffer.byteLength(patch, "utf-8")} byte patch`;
      });

      if (diffOk) {
        await step("apply-check", async () => {
          const patchFile = path.join(repo, "..", `${path.basename(repo)}.patch`);
          try {
            await deps.writeFile(patchFile, patch);
            // Restore the clean tree, then validate and apply the patch the way SHIP does.
            await inRepo(["checkout", "--", "probe.txt"]);
            await inRepo(["apply", "--check", patchFile]);
            await inRepo(["apply", "--index", patchFile]);
            const staged = (await inRepo(["diff", "--cached"])).stdout;
            if (staged !== patch) throw assertion("the applied patch did not reproduce byte-for-byte");
            await inRepo(["diff", "--cached", "--check"]);
            return "apply --check, apply --index, byte-identical";
          } finally {
            await deps.rm(patchFile).catch(() => undefined);
          }
        });
      }
    }

    // 6. Always clean up; a leftover directory is itself a failure.
    await step("cleanup", async () => {
      if (!dir) return "nothing to clean";
      await deps.rm(dir);
      if (deps.exists(dir)) throw assertion("temporary directory still exists after cleanup");
      return "removed";
    });
  }

  return { ok: steps.length > 0 && steps.every((s) => s.ok), gitVersion, steps, at: new Date(deps.now()).toISOString() };
}

// ---- cold-start log line ----

// One clear line per function instance. Never prints environment, tokens, or paths.
export function describeRuntimeGit(result: { available: boolean; version?: string }): {
  level: "info" | "error";
  message: string;
} {
  if (result.available) {
    return { level: "info", message: `[hubris] runtime check: git ${result.version ?? ""} is available.`.replace("  ", " ") };
  }
  return {
    level: "error",
    message:
      "[hubris] runtime check FAILED: no git binary in this runtime. Analysis, Reproduce, Forge and SHIP cannot work here. " +
      "Call POST /api/diagnostics/git (with x-hubris-api-key) for the full check; see docs/deployment.md.",
  };
}
