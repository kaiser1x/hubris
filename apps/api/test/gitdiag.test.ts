import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultGitDiagDeps,
  describeRuntimeGit,
  isSafeProbeUrl,
  runGitDiagnostics,
  type GitDiagDeps,
} from "../src/gitdiag";
import { classifyGitError, GIT_UNAVAILABLE_MESSAGE, hintFor, isMissingBinary, safeGitDetail } from "../src/gitenv";
import { cloneAndArchive } from "../src/checkout";

// The diagnostics run inside the DEPLOYED function (a different image from the
// build container). Locally we can prove: they work against a real git, they
// classify every failure mode clearly and safely, they never leak credentials,
// and they always clean up. Whether the Vercel runtime actually has git needs a
// Preview deployment (POST /api/diagnostics/git).

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

function localProbeRepo(): { url: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-probe-origin-"));
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  return { url: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Windows env keys are case-insensitive: stub the ONE key that really exists, or
// the second stub records the first stub's value as the "original" and PATH is
// never restored.
function stubEmptyPath(dir: string): void {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  vi.stubEnv(key, dir);
}

const leftoverDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("hubris-gitdiag-"));

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
}

// Fake deps: every git call returns plausible output unless `fail` throws.
function fakeDeps(over: {
  fail?: (args: string[]) => unknown;
  exists?: boolean;
  mkdtempError?: unknown;
  version?: string;
} = {}) {
  const calls: string[][] = [];
  const removed: string[] = [];
  let patch = "";
  const deps: GitDiagDeps = {
    exec: async (args) => {
      calls.push(args);
      const failure = over.fail?.(args);
      if (failure) throw failure;
      if (args[0] === "--version") return { stdout: over.version ?? "git version 2.45.1\n", stderr: "" };
      if (args[0] === "ls-remote") return { stdout: `${"a".repeat(40)}\tHEAD\n`, stderr: "" };
      if (args[0] === "diff" && args.length === 1) {
        patch = "diff --git a/probe.txt b/probe.txt\n--- a/probe.txt\n+++ b/probe.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+beta changed\n";
        return { stdout: patch, stderr: "" };
      }
      if (args[0] === "diff" && args.includes("--cached") && !args.includes("--check")) return { stdout: patch, stderr: "" };
      return { stdout: "", stderr: "" };
    },
    mkdtemp: async (prefix) => {
      if (over.mkdtempError) throw over.mkdtempError;
      return `${prefix}fake`;
    },
    writeFile: async () => undefined,
    rm: async (dir) => {
      removed.push(dir);
    },
    exists: () => over.exists ?? false,
    tmpdir: () => "/tmp",
    now: () => 1_700_000_000_000,
  };
  return { deps, calls, removed };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("git diagnostics against a REAL git", () => {
  it("version, read-only ls-remote, temp repo, diff --check, apply --check, byte-identical apply, cleanup", async () => {
    const origin = localProbeRepo();
    const before = leftoverDirs();
    try {
      const report = await runGitDiagnostics({ probeRepo: origin.url });
      expect(report.steps.map((s) => [s.step, s.ok])).toEqual([
        ["version", true],
        ["ls-remote", true],
        ["temp-repo", true],
        ["diff-check", true],
        ["apply-check", true],
        ["cleanup", true],
      ]);
      expect(report.ok).toBe(true);
      expect(report.gitVersion).toMatch(/^\d+\.\d+/);
      expect(report.steps.find((s) => s.step === "apply-check")?.detail).toContain("byte-identical");
      // Cleaned up: nothing new left in the temp directory.
      expect(leftoverDirs().sort()).toEqual(before.sort());
    } finally {
      origin.cleanup();
    }
  });

  it("a missing git binary (PATH without git) is reported as GIT_NOT_FOUND and nothing else runs", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-nopath-"));
    const before = leftoverDirs();
    try {
      stubEmptyPath(empty);
      const report = await runGitDiagnostics({ probeRepo: "https://example.invalid/x.git" });
      expect(report.ok).toBe(false);
      expect(report.gitVersion).toBeNull();
      expect(report.steps).toHaveLength(1);
      expect(report.steps[0]).toMatchObject({ step: "version", ok: false, code: "GIT_NOT_FOUND" });
      expect(report.steps[0].hint).toMatch(/No `git` executable/);
      expect(leftoverDirs().sort()).toEqual(before.sort());
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("production staging maps a missing binary to 'git-missing' and a bad remote to 'clone'", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-stage-"));
    try {
      await expect(cloneAndArchive(path.join(tmp, "does-not-exist"), undefined, tmp)).rejects.toThrow("clone");
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-nopath-"));
      stubEmptyPath(empty);
      try {
        await expect(cloneAndArchive("https://github.com/o/r.git", undefined, tmp)).rejects.toThrow("git-missing");
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never echoes environment values into the report", async () => {
    const origin = localProbeRepo();
    try {
      vi.stubEnv("GITHUB_TOKEN", "ghp_SUPERSECRETTOKENVALUE123456");
      vi.stubEnv("NEBIUS_API_KEY", "nebius-secret-key-value");
      vi.stubEnv("DATABASE_URL", "postgresql://user:hunter2@db.example/x");
      const text = JSON.stringify(await runGitDiagnostics({ probeRepo: origin.url }));
      for (const secret of ["SUPERSECRETTOKENVALUE", "nebius-secret-key-value", "hunter2"]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      origin.cleanup();
    }
  });
});

describe("failure modes (injected git)", () => {
  it("passes end to end with a well-behaved git", async () => {
    const { deps, removed } = fakeDeps();
    const report = await runGitDiagnostics({ deps });
    expect(report.ok).toBe(true);
    expect(removed.some((d) => d.endsWith("fake"))).toBe(true);
  });

  it("missing binary: one failed step, no temp directory created, actionable hint", async () => {
    const { deps, calls } = fakeDeps({ fail: () => enoent() });
    const mkdtemp = vi.spyOn(deps, "mkdtemp");
    const report = await runGitDiagnostics({ deps });
    expect(report.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(report.steps[0]).toMatchObject({ code: "GIT_NOT_FOUND" });
    expect(report.steps[0].hint).toBe(hintFor("GIT_NOT_FOUND"));
  });

  it("an unrecognised `git --version` is an incompatibility, not a pass", async () => {
    const { deps } = fakeDeps({ version: "not git at all" });
    const report = await runGitDiagnostics({ deps });
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ step: "version", code: "GIT_UNEXPECTED_OUTPUT" });
  });

  it("ls-remote network failure: classified, credentials redacted, the local steps still run", async () => {
    const leak = Object.assign(new Error("Command failed"), {
      stderr: "fatal: unable to access 'https://x-access-token:ghp_ABCDEF0123456789SECRET@github.com/o/r.git/': Could not resolve host: github.com",
    });
    const { deps } = fakeDeps({ fail: (a) => (a[0] === "ls-remote" ? leak : null) });
    const report = await runGitDiagnostics({ deps });
    const ls = report.steps.find((s) => s.step === "ls-remote")!;
    expect(ls).toMatchObject({ ok: false, code: "GIT_NETWORK" });
    expect(ls.hint).toMatch(/outbound HTTPS/);
    expect(JSON.stringify(report)).not.toContain("ghp_ABCDEF0123456789SECRET");
    expect(JSON.stringify(report)).not.toContain("x-access-token:ghp");
    expect(report.ok).toBe(false);
    // Network trouble does not hide whether local patch validation works.
    expect(report.steps.find((s) => s.step === "apply-check")?.ok).toBe(true);
    expect(report.steps.find((s) => s.step === "cleanup")?.ok).toBe(true);
  });

  it("a git build without an HTTPS transport is called out", async () => {
    const err = Object.assign(new Error("x"), { stderr: "git: 'remote-https' is not a git command. See 'git --help'." });
    const { deps } = fakeDeps({ fail: (a) => (a[0] === "ls-remote" ? err : null) });
    const ls = (await runGitDiagnostics({ deps })).steps.find((s) => s.step === "ls-remote")!;
    expect(ls.code).toBe("GIT_HTTPS_UNSUPPORTED");
  });

  it("a timeout is classified as a timeout", async () => {
    const err = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
    const { deps } = fakeDeps({ fail: (a) => (a[0] === "ls-remote" ? err : null) });
    expect((await runGitDiagnostics({ deps })).steps.find((s) => s.step === "ls-remote")?.code).toBe("GIT_TIMEOUT");
  });

  it("an unwritable temp directory fails the temp-repo step, skips patch steps, and has nothing to clean", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied, mkdtemp '/tmp/hubris-gitdiag-'"), { code: "EACCES" });
    const { deps, removed } = fakeDeps({ mkdtempError: eacces });
    const report = await runGitDiagnostics({ deps });
    expect(report.steps.map((s) => s.step)).toEqual(["version", "ls-remote", "temp-repo", "cleanup"]);
    expect(report.steps[2]).toMatchObject({ ok: false, code: "TMP_NOT_WRITABLE" });
    expect(report.steps[3]).toMatchObject({ ok: true, detail: "nothing to clean" });
    expect(removed).toHaveLength(0);
    expect(report.ok).toBe(false);
  });

  it("a patch that git rejects fails apply-check, but the temp repo and patch file are still cleaned up", async () => {
    const err = Object.assign(new Error("x"), { stderr: "error: patch failed: probe.txt:1\nerror: probe.txt: patch does not apply" });
    const { deps, removed } = fakeDeps({ fail: (a) => (a[0] === "apply" && a.includes("--check") ? err : null) });
    const report = await runGitDiagnostics({ deps });
    expect(report.steps.find((s) => s.step === "apply-check")).toMatchObject({ ok: false, code: "GIT_APPLY_FAILED" });
    expect(removed.some((d) => d.endsWith(".patch"))).toBe(true);
    expect(removed.some((d) => d.endsWith("fake"))).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("a `git diff --check` failure stops patch validation there", async () => {
    const err = Object.assign(new Error("x"), { stderr: "probe.txt:2: trailing whitespace." });
    const { deps } = fakeDeps({ fail: (a) => (a[0] === "diff" && a.includes("--check") && !a.includes("--cached") ? err : null) });
    const report = await runGitDiagnostics({ deps });
    expect(report.steps.map((s) => s.step)).not.toContain("apply-check");
    expect(report.steps.find((s) => s.step === "diff-check")?.ok).toBe(false);
  });

  it("a directory that survives cleanup is a failure", async () => {
    const { deps } = fakeDeps({ exists: true });
    const report = await runGitDiagnostics({ deps });
    expect(report.steps.find((s) => s.step === "cleanup")).toMatchObject({ ok: false, code: "GIT_UNEXPECTED_OUTPUT" });
  });

  it("the default executor never prompts for credentials", () => {
    expect(defaultGitDiagDeps.exec.toString()).toContain("GIT_TERMINAL_PROMPT");
  });
});

describe("error classification and sanitizing", () => {
  it("recognises a missing binary and distinguishes failure kinds", () => {
    expect(isMissingBinary(enoent())).toBe(true);
    expect(isMissingBinary(new Error("fatal: repository not found"))).toBe(false);
    expect(classifyGitError(enoent())).toBe("GIT_NOT_FOUND");
    expect(classifyGitError({ stderr: "Could not resolve host: github.com" })).toBe("GIT_NETWORK");
    expect(classifyGitError({ stderr: "fatal: repository 'x' not found" })).toBe("GIT_FAILED");
    expect(classifyGitError(null)).toBe("GIT_FAILED");
  });

  it("strips URL credentials, bearer tokens, GitHub tokens, and supplied secrets", () => {
    const detail = safeGitDetail(
      {
        stderr:
          "fatal: unable to access 'https://user:pa55w0rd@github.com/o/r.git/' Authorization: Bearer abc.DEF-123 token ghp_0123456789ABCDEFGHIJ extra literal-secret-value",
      },
      ["literal-secret-value"]
    );
    for (const leaked of ["pa55w0rd", "abc.DEF-123", "ghp_0123456789ABCDEFGHIJ", "literal-secret-value"]) {
      expect(detail).not.toContain(leaked);
    }
    expect(detail).toContain("<redacted>");
  });

  it("bounds the detail and survives non-error input", () => {
    expect(safeGitDetail({ stderr: "x".repeat(5000) }).length).toBeLessThanOrEqual(240);
    expect(safeGitDetail(undefined)).toBe("unknown error");
    expect(safeGitDetail("plain string")).toBe("unknown error");
  });

  it("only plain https probe URLs without credentials are accepted from configuration", () => {
    expect(isSafeProbeUrl("https://github.com/octocat/Hello-World.git")).toBe(true);
    for (const bad of ["http://github.com/x.git", "https://u:p@github.com/x.git", "file:///etc", "git@github.com:o/r.git", "", 42]) {
      expect(isSafeProbeUrl(bad as unknown)).toBe(false);
    }
  });

  it("the user-facing unavailable message is safe and actionable", () => {
    expect(GIT_UNAVAILABLE_MESSAGE).toMatch(/no git binary/);
    expect(GIT_UNAVAILABLE_MESSAGE).toMatch(/GET \/ready/);
  });

  it("the cold-start log line is one clear sentence either way", () => {
    expect(describeRuntimeGit({ available: true, version: "2.45.1" })).toEqual({
      level: "info",
      message: "[hubris] runtime check: git 2.45.1 is available.",
    });
    const failed = describeRuntimeGit({ available: false });
    expect(failed.level).toBe("error");
    expect(failed.message).toContain("no git binary");
    expect(failed.message).toContain("POST /api/diagnostics/git");
  });
});
