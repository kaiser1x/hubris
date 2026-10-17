// Phase C — repository checkout orchestration helpers.
//
// Transfer model: the API shallow-clones the job's public repoUrl locally
// (same trust posture as /api/analyze — never executes repo code), archives
// TRACKED files with `git archive` (no .git dir, no node_modules, no local
// build output travels), uploads the single tarball via uploadFile, then
// spawns a disposable sandbox that extracts it to REPO_WORKDIR and reports
// a bounded manifest. The sandbox never receives host credentials — only the
// tarball uuid and shell commands.
//
// Secret-adjacent tracked files (.env, key material) are removed inside the
// sandbox right after extraction and recorded in evidence. Their presence in
// the tarball in transit is accepted: the sandbox namespace is ours, and
// refusing whole checkouts over one committed secret would wedge demos.
// Host secrets (NEBIUS_*, GITHUB_TOKEN, DATABASE_URL) are never in scope:
// they live in server env, never in the clone, never in the spawn payload.

import { execFile } from "child_process";
import { isMissingBinary } from "./gitenv";
import { promisify } from "util";
import * as path from "path";
import { REPO_WORKDIR } from "@hubris/sandbox";

const execFileAsync = promisify(execFile);

// Sandbox path the uploaded tarball is mapped to (via SpawnRequest.files).
export const CHECKOUT_UPLOAD_PATH = "/tmp/hubris-upload/repo.tar";

const EXCLUDED_BASENAMES = new Set([".env", ".env.local"]);
const EXCLUDED_EXTENSIONS = [".pem", ".key"];

// Repo-relative (git ls-files style, forward slashes) tracked paths that
// must not survive in the sandbox workspace.
export function isTransferExcluded(repoPath: string): boolean {
  const base = repoPath.split("/").pop() ?? "";
  if (base === ".env.example") return false;
  if (EXCLUDED_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && EXCLUDED_EXTENSIONS.includes(base.slice(dot))) return true;
  return false;
}

export interface CheckoutLimits {
  maxFiles: number;
  maxBytes: number;
}

// Conservative Phase 6 seeds: a 5000-file / 50MB-tarball ceiling stops
// accidental (or malicious, via a crafted public repo) giant transfers.
// Install/test-execution limits land in Phase D.
export const DEFAULT_CHECKOUT_LIMITS: CheckoutLimits = {
  maxFiles: 5000,
  maxBytes: 50_000_000,
};

export function limitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CheckoutLimits {
  const files = Number(env.HUBRIS_MAX_REPO_FILES);
  const bytes = Number(env.HUBRIS_MAX_REPO_BYTES);
  return {
    maxFiles:
      Number.isFinite(files) && files > 0 ? Math.floor(files) : DEFAULT_CHECKOUT_LIMITS.maxFiles,
    maxBytes:
      Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : DEFAULT_CHECKOUT_LIMITS.maxBytes,
  };
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Bounded workspace setup + manifest. Output is small by construction:
// at most 100 file lines plus a COUNT line; evidence truncates anyway.
export function buildCheckoutScript(excluded: string[]): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `echo FILES_BEGIN; find . -type f | sort | head -100; echo FILES_END; ` +
    `echo COUNT $(find . -type f | wc -l)`
  );
}

export function parseCheckoutListing(stdout: string): {
  count: number | null;
  excerpt: string;
} {
  const m = stdout.match(/COUNT\s+(\d+)/);
  return { count: m ? Number(m[1]) : null, excerpt: stdout.slice(0, 4000) };
}

export interface StagedRepo {
  src: string;
  tarPath: string;
  tracked: string[];
  // Commit the checked-out ref resolved to (git rev-parse HEAD in the
  // clone). Binds ref → exact revision for downstream evidence. Null when
  // unresolvable — never fabricated.
  commitSha: string | null;
}

// Clone + list + archive under tmp. Never executes repo code — pure git
// plumbing. Throws Error("clone" | "ls-files" | "archive") so handlers can
// map to responses without leaking subprocess details.
//
// Line-ending pin: `git archive` honors the host's core.autocrlf, so a
// Windows host would silently rewrite LF blobs to CRLF in the tarball and
// stock-Debian `git apply` would then reject LF-context patches. The
// `-c core.autocrlf=false` override forces raw blob bytes regardless of
// host config. Permissive apply (--ignore-whitespace) is deliberately NOT
// used: the tarball must be byte-faithful, not fuzz-matched.
export async function cloneAndArchive(
  cloneUrl: string,
  ref: string | undefined,
  tmp: string,
  expectedCommitSha?: string
): Promise<StagedRepo> {
  const src = path.join(tmp, "src");
  const tarPath = path.join(tmp, "repo.tar");
  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), cloneUrl, src],
      { timeout: 90000 }
    );
  } catch (error) {
    // A host without git is not a failed clone: say so, so callers can report
    // the runtime problem instead of blaming the repository.
    throw new Error(isMissingBinary(error) ? "git-missing" : "clone");
  }
  if (expectedCommitSha) {
    if (!/^[a-f0-9]{40}$/.test(expectedCommitSha)) throw new Error("revision-mismatch");
    try {
      await execFileAsync("git", ["-C", src, "fetch", "--depth", "1", "origin", expectedCommitSha], {
        timeout: 90000,
      });
      await execFileAsync("git", ["-C", src, "checkout", "--detach", expectedCommitSha], {
        timeout: 30000,
      });
    } catch {
      throw new Error("revision-mismatch");
    }
  }
  let tracked: string[];
  try {
    const ls = await execFileAsync("git", ["-C", src, "ls-files", "-z"], {
      timeout: 30000,
    });
    tracked = ls.stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    throw new Error("ls-files");
  }
  try {
    await execFileAsync(
      "git",
      ["-c", "core.autocrlf=false", "-C", src, "archive", "HEAD", "-o", tarPath],
      { timeout: 60000 }
    );
  } catch {
    throw new Error("archive");
  }
  let commitSha: string | null = null;
  try {
    const rev = await execFileAsync("git", ["-C", src, "rev-parse", "HEAD"], {
      timeout: 30000,
    });
    const sha = rev.stdout.trim();
    if (/^[a-f0-9]{40}$/.test(sha)) commitSha = sha;
  } catch {
    commitSha = null;
  }
  if (expectedCommitSha) {
    const stagedCommit = await execFileAsync("git", ["-C", src, "rev-parse", "HEAD"], {
      timeout: 30000,
    });
    if (stagedCommit.stdout.trim() !== expectedCommitSha) throw new Error("revision-mismatch");
  }
  return { src, tarPath, tracked, commitSha: await resolvedCommitSha(src) };
}

async function resolvedCommitSha(src: string): Promise<string | null> {
  try {
    const rev = await execFileAsync("git", ["-C", src, "rev-parse", "HEAD"], {
      timeout: 30000,
    });
    const sha = rev.stdout.trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
