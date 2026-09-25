// Repo-aware sandbox commands (Phase B.1).
//
// The ConTree REST surface used here only executes a shell command in a
// disposable instance — there is no separate "clone this repo" endpoint.
// So a repo-aware run wraps the user's script:
//
//   set -e; rm -rf /tmp/hubris-repo
//   git clone --depth 1 [--branch <ref>] <repoUrl> /tmp/hubris-repo
//   cd /tmp/hubris-repo; <script>
//
// Everything interpolated from untrusted input is single-quote escaped and
// repoUrl/ref are allow-list validated first, so the wrapper cannot be used
// for shell injection. Callers must still cap script length (the API does).

export const REPO_WORKDIR = "/tmp/hubris-repo";

// Only public github.com repos, mirroring the API's toSafeCloneUrl contract.
// Kept local (duplicated) so @hubris/sandbox has no dependency on apps/api.
export function toSafeCloneUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com")
      return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (!/^[\w.-]+$/.test(owner)) return null;
    const name = repo.replace(/\.git$/, "");
    if (!/^[\w.-]+$/.test(name)) return null;
    return `https://github.com/${owner}/${name}.git`;
  } catch {
    return null;
  }
}

// Branch/tag names only (no commit SHAs yet — those need fetch+checkout,
// not --branch). Rejects shell metachars, option-injection leading dashes,
// and path traversal.
export function isSafeGitRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > 100) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.startsWith(".")) return false;
  if (ref.includes("..")) return false;
  if (ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return true;
}

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildRepoCheckoutCommand(
  repoUrl: string,
  script: string,
  ref?: string
): string {
  const cloneUrl = toSafeCloneUrl(repoUrl);
  if (!cloneUrl) {
    throw new Error("Only public https://github.com/owner/repo URLs are supported.");
  }
  if (ref !== undefined && !isSafeGitRef(ref)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
  const dir = shQuote(REPO_WORKDIR);
  const url = shQuote(cloneUrl);
  const branch = ref !== undefined ? ` --branch ${shQuote(ref)}` : "";
  return `set -e; rm -rf ${dir}; git clone --depth 1${branch} ${url} ${dir}; cd ${dir}; ${script}`;
}
