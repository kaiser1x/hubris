"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { fetchRecentJobs, type LiveJob } from "../lib/live-twin";
import { jobRepositoryContext, workspaceHref } from "../lib/workspace";
import { useWorkspace } from "./WorkspaceProvider";

export default function WorkspaceSwitcher() {
  const { job, jobId, selectJob } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const [jobs, setJobs] = useState<LiveJob[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchRecentJobs(50).then((next) => {
      if (!cancelled) setJobs(next.filter((candidate) => candidate.status === "complete"));
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const options = job && !jobs.some((candidate) => candidate.id === job.id) ? [job, ...jobs] : jobs;

  return (
    <label className="block border border-[#393737] px-2.5 py-3 mb-9">
      <span className="block font-mono text-[9px] tracking-[0.12em] text-[#8b8585] mb-2">
        ACTIVE REPOSITORY
      </span>
      <select
        aria-label="Switch analyzed repository"
        value={jobId ?? ""}
        onChange={(event) => {
          const nextId = event.target.value || null;
          void selectJob(nextId);
          router.replace(workspaceHref(pathname, { jobId: nextId }));
        }}
        className="w-full bg-[#0A0A0A] text-white font-mono text-[11px] focus:outline-none"
      >
        {!jobId && <option value="">No analyzed repository</option>}
        {options.map((candidate) => {
          const context = jobRepositoryContext(candidate);
          return (
            <option key={candidate.id} value={candidate.id}>
              {context.label} · {candidate.id.slice(0, 8)}
            </option>
          );
        })}
      </select>
    </label>
  );
}
