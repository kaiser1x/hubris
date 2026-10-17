// What HUBRIS needs from the host's `git`, and how a missing or failing git is
// described. Everything user- or log-facing here is SAFE by construction: it
// never includes environment values, tokens, or credentialed URLs.
//
// Production code paths that spawn git (audited):
//   checkout.ts  cloneAndArchive: clone, fetch <sha>, checkout --detach, ls-files,
//                archive, rev-parse                      (analyze/reproduce/forge/…)
//   app.ts       POST /api/analyze: clone, rev-parse; forge-structured: show HEAD:<path>
//   ship.ts      SHIP: init, remote add, fetch <sha>, checkout, ls-remote, apply --index,
//                diff --cached [--check|--name-only], commit, push (hubris/* only)
//   runtime.ts / gitdiag.ts: `git --version` and the diagnostics below.
// Nothing else in the API spawns a process. Sandbox commands run remotely.

export type GitFailureCode =
  | "GIT_NOT_FOUND"
  | "GIT_TIMEOUT"
  | "GIT_NETWORK"
  | "GIT_HTTPS_UNSUPPORTED"
  | "TMP_NOT_WRITABLE"
  | "GIT_APPLY_FAILED"
  | "GIT_UNEXPECTED_OUTPUT"
  | "GIT_FAILED";

export const GIT_UNAVAILABLE_MESSAGE =
  "This server cannot run git, which repository operations require. The runtime has no git binary " +
  "(check GET /ready and docs/deployment.md), so analysis, reproduction, Forge and SHIP are unavailable here.";

const HINTS: Record<GitFailureCode, string> = {
  GIT_NOT_FOUND:
    "No `git` executable on PATH in this runtime. Repository operations cannot work here: run the API on a host that provides git, or replace the git calls.",
  GIT_TIMEOUT: "A git command exceeded its time limit. Check network egress and the function's maximum duration.",
  GIT_NETWORK:
    "git could not reach the remote. Check that the runtime allows outbound HTTPS to github.com and that DNS resolves.",
  GIT_HTTPS_UNSUPPORTED:
    "This git build has no HTTPS transport (git-remote-https missing), so it cannot clone or fetch from GitHub.",
  TMP_NOT_WRITABLE: "The temporary directory is not writable or is full. Repository staging needs a writable os.tmpdir().",
  GIT_APPLY_FAILED:
    "git could not validate a patch in a temporary repository. Patch validation (git apply / git diff --check) will not work here.",
  GIT_UNEXPECTED_OUTPUT: "git produced output HUBRIS does not recognise; the installed git may be incompatible.",
  GIT_FAILED: "A git command failed. See the step detail.",
};

export function hintFor(code: GitFailureCode): string {
  return HINTS[code];
}

interface ErrorLike {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
  message?: unknown;
}

// execFile reports a missing executable as code "ENOENT" (spawn git ENOENT).
export function isMissingBinary(error: unknown): boolean {
  return (error as ErrorLike | null)?.code === "ENOENT";
}

export function classifyGitError(error: unknown): GitFailureCode {
  const e = (error ?? {}) as ErrorLike;
  if (e.code === "ENOENT") return "GIT_NOT_FOUND";
  if (e.code === "EACCES" || e.code === "EROFS" || e.code === "ENOSPC" || e.code === "EMFILE") {
    // EACCES on spawn can also mean a non-executable binary; stderr/message disambiguates.
    const text = `${String(e.message ?? "")}`;
    return /spawn/i.test(text) ? "GIT_NOT_FOUND" : "TMP_NOT_WRITABLE";
  }
  if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") return "GIT_TIMEOUT";
  const text = `${String(e.stderr ?? "")}\n${String(e.message ?? "")}`;
  if (/remote-https|is not a git command/i.test(text)) return "GIT_HTTPS_UNSUPPORTED";
  if (/could not resolve host|unable to access|could not read from remote|ssl|certificate|connection (refused|timed out|reset)|network is unreachable/i.test(text)) {
    return "GIT_NETWORK";
  }
  if (/patch failed|does not apply|corrupt patch|error: patch/i.test(text)) return "GIT_APPLY_FAILED";
  return "GIT_FAILED";
}

// Bounded, credential-free description of a failure for logs and responses.
// Strips userinfo from URLs, bearer tokens, x-access-token credentials, and any
// literal secret passed in; collapses whitespace; caps the length.
export function safeGitDetail(error: unknown, secrets: Array<string | null | undefined> = []): string {
  const e = (error ?? {}) as ErrorLike;
  let text = `${String(e.stderr ?? "").trim() || String(e.message ?? "").trim() || "unknown error"}`;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  text = text
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1<redacted>@")
    .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:<redacted>@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "<redacted>")
    .replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
