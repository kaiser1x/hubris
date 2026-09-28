// Authoritative repository-context derivation for the active workspace.
//
// The analyzed job is the single source of truth for which repository the
// UI is working against. Every page derives its repository identity through
// this module — never through hardcoded demo values, never through "latest
// job" guessing when an explicit id exists.
//
// Precedence for the authoritative job id:
//   1. ?jobId= in the URL (explicit, wins for that navigation)
//   2. the persisted active job id (survives refresh / navigation)
//   3. the latest completed analysis job (workspace with no explicit pick)
//
// Legacy jobs (analyzed before repository metadata existed) are reported as
// context-unavailable. They never silently fall back to a demo repository.

import type { LiveJob } from "./live-twin";

export const ACTIVE_JOB_STORAGE_KEY = "hubris.activeJobId";

// Safe display labels for jobs whose repository identity cannot be proven.
export const REPOSITORY_UNAVAILABLE_LABEL = "Repository context unavailable";
export const LEGACY_JOB_LABEL = "Legacy job requires re-analysis";

export interface JobRepositoryContext {
  jobId: string | null;
  // e.g. "owner/repository"
  repoName: string | null;
  owner: string | null;
  repo: string | null;
  // Analyzed ref persisted by POST /api/analyze (result.ref).
  ref: string | null;
  // Analyzed commit persisted by POST /api/analyze (result.commitSha).
  commitSha: string | null;
  repositoryUrl: string | null;
  status: string | null;
  analysisStatus: string | null;
  // Whether a repository identity is actually derivable from the job.
  hasContext: boolean;
  // Safe display label: repo name when proven, explicit unavailable text
  // otherwise. Never a demo repository.
  label: string;
}

export interface WorkspaceLinkContext {
  jobId?: string | null;
  investigationId?: string | null;
  forgeRunId?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function repoNameFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl || typeof repoUrl !== "string") return null;
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1].replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return `${owner}/${repo}`;
  } catch {
    const parts = String(repoUrl).split("/").filter(Boolean);
    const last = parts[parts.length - 1]?.replace(/\.git$/, "");
    const prev = parts[parts.length - 2];
    return prev && last ? `${prev}/${last}` : null;
  }
}

// Derive the authoritative repository context from a job's persisted state.
// Total function: any shape yields a context object, never throws.
export function jobRepositoryContext(job: LiveJob | null | undefined): JobRepositoryContext {
  const base = {
    jobId: null,
    repoName: null,
    owner: null,
    repo: null,
    ref: null,
    commitSha: null,
    repositoryUrl: null,
    status: null,
    analysisStatus: null,
    hasContext: false,
    label: REPOSITORY_UNAVAILABLE_LABEL,
  };
  if (!job || typeof job !== "object") return base;

  const result = isRecord(job.result) ? job.result : null;
  const repository = isRecord(result?.repository) ? result.repository : null;
  const repoName =
    asString(repository?.name) ?? repoNameFromUrl(job.repoUrl);
  const ref = asString(result?.ref);
  const commitSha = asString(result?.commitSha);
  const analysisStatus = asString(repository?.analysisStatus);
  const hasContext = Boolean(repoName) && repoName !== REPOSITORY_UNAVAILABLE_LABEL;

  const [owner, repo] = hasContext && repoName ? splitRepoName(repoName) : [null, null];
  return {
    jobId: asString(job.id) ?? null,
    repoName,
    owner,
    repo,
    ref,
    commitSha,
    repositoryUrl: asString(job.repoUrl) ?? null,
    status: asString(job.status) ?? null,
    analysisStatus,
    hasContext,
    label: hasContext && repoName ? repoName : legacyOrUnavailable(job),
  };
}

function splitRepoName(name: string): [string | null, string | null] {
  const parts = name.split("/");
  if (parts.length < 2) return [null, name];
  return [parts[parts.length - 2], parts[parts.length - 1]];
}

// Canonical repository identity for a job, used to group duplicate analysis
// jobs of the same repository. Null when the job has no provable identity.
export function jobRepositoryIdentity(job: LiveJob | null | undefined): string | null {
  if (!job) return null;
  return jobRepositoryContext(job).repoName ?? repoNameFromUrl(job.repoUrl);
}

// A job with a repoUrl but no derivable repository name is a legacy job.
function legacyOrUnavailable(job: LiveJob): string {
  return repoNameFromUrl(job.repoUrl) ? LEGACY_JOB_LABEL : REPOSITORY_UNAVAILABLE_LABEL;
}

// ---- Active job id storage (browser-only) ----

export function readActiveJobId(storage?: Storage | null): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACTIVE_JOB_STORAGE_KEY);
    if (!raw) return null;
    return /^[a-zA-Z0-9-]{1,120}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeActiveJobId(id: string | null, storage?: Storage | null): void {
  if (!storage) return;
  try {
    if (id) storage.setItem(ACTIVE_JOB_STORAGE_KEY, id);
    else storage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  } catch {
    // storage unavailable; workspace context still resolves per-navigation
  }
}

// ---- Removed repositories (presentational only) ----
//
// A repository the user removed from HUBRIS is hidden from the selector by
// canonical owner/repo identity. This is purely a HUBRIS-side list: it never
// deletes jobs, investigations, Forge runs, verifications, or provenance, and
// it NEVER touches the GitHub repository. Multiple analysis jobs for the same
// repository share one identity, so removing hides all of them at once.

export const REMOVED_REPOS_STORAGE_KEY = "hubris.removedRepos";

const REPO_IDENTITY_RE = /^[\w.-]+\/[\w.-]+$/;

export function isCanonicalRepoName(value: unknown): value is string {
  return typeof value === "string" && REPO_IDENTITY_RE.test(value);
}

export function readRemovedRepos(storage?: Storage | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(REMOVED_REPOS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCanonicalRepoName);
  } catch {
    return [];
  }
}

export function writeRemovedRepos(repos: string[], storage?: Storage | null): void {
  if (!storage) return;
  try {
    const unique = [...new Set(repos.filter(isCanonicalRepoName))];
    if (unique.length === 0) storage.removeItem(REMOVED_REPOS_STORAGE_KEY);
    else storage.setItem(REMOVED_REPOS_STORAGE_KEY, JSON.stringify(unique));
  } catch {
    // storage unavailable; removal is a best-effort presentational hint
  }
}

export function addRemovedRepo(repoName: string, storage?: Storage | null): void {
  if (!isCanonicalRepoName(repoName)) return;
  writeRemovedRepos([...readRemovedRepos(storage), repoName], storage);
}

// Undo: drop the identity from the removed list so it is selectable again.
export function removeRemovedRepo(repoName: string, storage?: Storage | null): void {
  if (!repoName) return;
  writeRemovedRepos(
    readRemovedRepos(storage).filter((name) => name !== repoName),
    storage
  );
}

export function isRepoRemoved(
  repoName: string | null | undefined,
  storage?: Storage | null
): boolean {
  if (!repoName) return false;
  return readRemovedRepos(storage).includes(repoName);
}


// Extract the authoritative job id from a URLSearchParams, if present.
export function jobIdFromSearch(search: URLSearchParams | null | undefined): string | null {
  const raw = search?.get("jobId");
  if (!raw) return null;
  return /^[a-zA-Z0-9-]{1,120}$/.test(raw) ? raw : null;
}

// Authoritative job id for a workspace: an explicit ?jobId= wins, then the
// persisted active job id. Null when neither exists — callers then resolve
// the latest completed analysis. Pure and testable.
export function activeJobIdPreference(
  search: URLSearchParams | null | undefined,
  storage?: Storage | null
): string | null {
  return jobIdFromSearch(search) ?? readActiveJobId(storage);
}

// Context-bound workspace links must carry the identity they were rendered
// from. Global pages can omit the context intentionally.
export function workspaceHref(
  pathname: string,
  context: WorkspaceLinkContext = {}
): string {
  const params = new URLSearchParams();
  if (context.jobId) params.set("jobId", context.jobId);
  if (context.investigationId) params.set("investigationId", context.investigationId);
  if (context.forgeRunId) params.set("forgeRunId", context.forgeRunId);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

// The workspace's missing-state labels, shared across pages so wording is
// consistent and never a demo repository.
export function workspaceEmptyLabel(hasJobs: boolean): string {
  return hasJobs
    ? "Analyze a repository to begin"
    : "No analyzed repository selected";
}
