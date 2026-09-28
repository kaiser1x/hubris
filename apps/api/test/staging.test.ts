import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { cloneAndArchive } from "../src/checkout";

const exec = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
});

// Simulate a Windows-style host for the git subprocesses below, immune to
// whatever the real machine config is. This is the configuration that
// silently rewrote LF blobs to CRLF in tarballs (Phase G diagnostic).
function stubHostileWindowsHost() {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.autocrlf");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
}

async function initLfRepo(dir: string): Promise<void> {
  fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
  const opts = { timeout: 30000 };
  await exec("git", ["init", dir], opts);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"], opts);
  await exec("git", ["-C", dir, "config", "user.name", "t"], opts);
  // Force an LF blob regardless of machine config.
  await exec("git", ["-C", dir, "-c", "core.autocrlf=false", "add", "a.ts"], opts);
  await exec(
    "git",
    ["-C", dir, "-c", "core.autocrlf=false", "commit", "-m", "x"],
    opts
  );
}

async function mkTmp(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("staging line endings (Phase G root cause)", () => {
  it("control: plain archive under hostile config converts LF to CRLF", async () => {
    stubHostileWindowsHost();
    const repo = await mkTmp("hubris-eol-repo-");
    try {
      await initLfRepo(repo);
      const out = path.join(repo, "plain.tar");
      await exec("git", ["-C", repo, "archive", "HEAD", "-o", out], { timeout: 30000 });
      const bytes = await fs.promises.readFile(out);
      // Documents the bug mechanism: without the choke-point pin, the
      // tarball carries CRLF and Debian git rejects LF-context patches.
      expect(bytes.includes("1;\r\n")).toBe(true);
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
    }
  });

  it("cloneAndArchive preserves LF blob bytes under hostile config", async () => {
    stubHostileWindowsHost();
    const repo = await mkTmp("hubris-eol-repo-");
    const work = await mkTmp("hubris-eol-work-");
    try {
      await initLfRepo(repo);
      const staged = await cloneAndArchive(repo, undefined, work);
      expect(staged.tracked).toEqual(["a.ts"]);
      const bytes = await fs.promises.readFile(staged.tarPath);
      expect(bytes.includes("export const x = 1;\n")).toBe(true);
      expect(bytes.includes("\r\n")).toBe(false);
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  });

  it("checks out the analyzed commit instead of a moving branch", async () => {
    const repo = await mkTmp("hubris-revision-repo-");
    const work = await mkTmp("hubris-revision-work-");
    const badWork = await mkTmp("hubris-revision-bad-");
    try {
      await initLfRepo(repo);
      const rev = (await exec("git", ["-C", repo, "rev-parse", "HEAD"], { timeout: 30000 })).stdout.trim();
      const staged = await cloneAndArchive(repo, undefined, work, rev);
      expect(staged.commitSha).toBe(rev);
      await expect(cloneAndArchive(repo, undefined, badWork, "f".repeat(40))).rejects.toThrow("revision-mismatch");
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
      await fs.promises.rm(work, { recursive: true, force: true });
      await fs.promises.rm(badWork, { recursive: true, force: true });
    }
  });

  it("LF patch applies to the staged tree under Debian-strict settings", async () => {
    stubHostileWindowsHost();
    const repo = await mkTmp("hubris-eol-repo-");
    const work = await mkTmp("hubris-eol-work-");
    try {
      await initLfRepo(repo);
      const staged = await cloneAndArchive(repo, undefined, work);
      const extract = path.join(work, "out");
      fs.mkdirSync(extract);
      // Windows tar needs cwd-relative paths (C: looks like a host).
      await exec("tar", ["-xf", "../repo.tar"], {
        cwd: extract,
        timeout: 30000,
      });
      const diff = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1,2 @@",
        " export const x = 1;",
        "+// probe",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(work, "probe.diff"), diff);
      // Stock-Debian strictness: no autocrlf tolerance, no whitespace crutch.
      await exec(
        "git",
        [
          "-c", "core.autocrlf=false",
          "-c", "core.whitespace=",
          "-C", extract,
          "apply", "--check", "../probe.diff",
        ],
        { timeout: 30000 }
      );
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  });
});
