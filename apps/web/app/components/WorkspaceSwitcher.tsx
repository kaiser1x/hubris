"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { fetchRecentJobs, type LiveJob } from "../lib/live-twin";
import {
  addRemovedRepo,
  jobRepositoryContext,
  jobRepositoryIdentity,
  readRemovedRepos,
  removeRemovedRepo,
  workspaceHref,
} from "../lib/workspace";
import { useWorkspace } from "./WorkspaceProvider";

export default function WorkspaceSwitcher() {
  const { job, jobId, selectJob } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const [jobs, setJobs] = useState<LiveJob[]>([]);
  // Removed repositories are a HUBRIS-side, persisted list — read from storage
  // (never jobs, never GitHub).
  const [removed, setRemoved] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRecentJobs(50).then((next) => {
      if (!cancelled) setJobs(next.filter((candidate) => candidate.status === "complete"));
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    setRemoved(readRemovedRepos(window.localStorage));
  }, []);

  // Hide every job whose canonical repository identity was removed.
  const visibleJobs = jobs.filter((candidate) => {
    const identity = jobRepositoryIdentity(candidate);
    return !identity || !removed.includes(identity);
  });
  const options =
    job && !visibleJobs.some((candidate) => candidate.id === job.id)
      ? [job, ...visibleJobs]
      : visibleJobs;

  const activeIdentity = jobRepositoryIdentity(job);
  const activeLabel = jobRepositoryContext(job).label;

  function confirmRemove() {
    if (!activeIdentity) return;
    addRemovedRepo(activeIdentity, window.localStorage);
    setRemoved(readRemovedRepos(window.localStorage));
    setConfirming(false);
    setRemovedNotice(activeIdentity);
    // The removed repository is no longer part of the saved workspace: clear
    // the active selection and return to the Codebase page. No unrelated
    // repository is auto-selected. Historical records are untouched.
    void selectJob(null);
    router.replace("/codebase");
  }

  function undoRemove() {
    if (!removedNotice) return;
    removeRemovedRepo(removedNotice, window.localStorage);
    setRemoved(readRemovedRepos(window.localStorage));
    setRemovedNotice(null);
  }

  return (
    <div className="border border-[#393737] px-2.5 py-3 mb-9">
      <span className="block font-mono text-[9px] tracking-[0.12em] text-[#8b8585] mb-2">
        REPOSITORY
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

      {removedNotice ? (
        <div className="mt-3">
          <p className="font-mono text-[10px] text-[#8b8585]">
            Repository removed from HUBRIS.
          </p>
          <button
            type="button"
            onClick={undoRemove}
            className="mt-2 font-mono text-[9px] tracking-[0.08em] text-white underline underline-offset-4 decoration-[#393737] hover:text-[#8b8585]"
          >
            UNDO
          </button>
        </div>
      ) : job && activeIdentity ? (
        <div className="mt-3">
          <p className="font-mono text-[11px] text-white break-all">{activeLabel}</p>
          {confirming ? (
            <div className="mt-2 border border-[#393737] p-2.5">
              <p className="font-mono text-[10px] text-white break-all">
                Remove {activeIdentity} from HUBRIS?
              </p>
              <p className="font-mono text-[9px] text-[#8b8585] mt-1 leading-4">
                This only removes the repository from your HUBRIS workspace. The GitHub repository
                will not be changed.
              </p>
              <div className="flex items-center gap-3 mt-2.5">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="font-mono text-[9px] tracking-[0.08em] text-[#8b8585] hover:text-white"
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  onClick={confirmRemove}
                  className="border border-[#393737] px-2 py-1 font-mono text-[9px] tracking-[0.08em] text-white hover:bg-white/10 active:scale-[0.98] transition-all"
                >
                  REMOVE FROM HUBRIS
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 mt-2">
              <button
                type="button"
                onClick={() => router.replace(workspaceHref("/codebase", { jobId }))}
                className="font-mono text-[9px] tracking-[0.08em] text-white underline underline-offset-4 decoration-[#393737] hover:text-[#8b8585]"
              >
                OPEN
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="font-mono text-[9px] tracking-[0.08em] text-[#8b8585] hover:text-white"
              >
                REMOVE FROM HUBRIS
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
