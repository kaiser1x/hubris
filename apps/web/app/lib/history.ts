import { resolveForgeRuns, type ForgeRunView } from "./forge-run";
import type { LiveJob } from "./live-twin";
import { jobRepositoryContext, workspaceHref } from "./workspace";

export interface HistoryEntry {
  id: string;
  kind: "investigation" | "forge";
  jobId: string;
  repository: string;
  status: string;
  at: string | null;
  target: string | null;
  detail: string;
  verification: string | null;
  href: string;
}

function repoName(job: LiveJob): string {
  // Repository identity is derived from the job's persisted context. Legacy
  // jobs without derivable metadata render the explicit unavailable label —
  // never a demo repository, never a fabricated name.
  return jobRepositoryContext(job).repoName ?? "Repository context unavailable";
}

function investigationEntries(job: LiveJob): HistoryEntry[] {
  const runs = job.result?.investigationRuns;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const run = raw as Record<string, unknown>;
    const id = typeof run.investigationId === "string" ? run.investigationId : null;
    const status = typeof run.status === "string" ? run.status : null;
    if (!id || !status) return [];
    const plan = run.plan && typeof run.plan === "object" ? (run.plan as Record<string, unknown>) : null;
    const target = plan?.target && typeof plan.target === "object" ? (plan.target as Record<string, unknown>) : null;
    const file = typeof target?.file === "string" ? target.file : null;
    const fn = typeof target?.function === "string" ? target.function : null;
    return [{
      id,
      kind: "investigation",
      jobId: job.id,
      repository: repoName(job),
      status,
      at: typeof run.createdAt === "string" ? run.createdAt : null,
      target: file && fn ? `${file} · ${fn}()` : null,
      detail: typeof run.focus === "string" ? run.focus : "Persisted investigation",
      verification: null,
      href: `/forge?jobId=${encodeURIComponent(job.id)}&investigationId=${encodeURIComponent(id)}`,
    }];
  });
}

function forgeEntries(job: LiveJob): HistoryEntry[] {
  return resolveForgeRuns(job).map((run: ForgeRunView) => ({
    id: run.id,
    kind: "forge",
    jobId: job.id,
    repository: repoName(job),
    status: run.status,
    at: run.at,
    target: run.edits[0] ? `${run.edits[0].path}${run.edits[0].function ? ` · ${run.edits[0].function}()` : ""}` : null,
    detail: run.focus ?? "Persisted Forge run",
    verification: run.verification
      ? `${run.verification.result} · exit ${run.verification.exitCode ?? "—"}`
      : null,
    href: workspaceHref("/forge", { jobId: job.id, investigationId: run.investigationId }),
  }));
}

export function buildHistoryEntries(jobs: LiveJob[]): HistoryEntry[] {
  return jobs
    .flatMap((job) => [...investigationEntries(job), ...forgeEntries(job)])
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}
