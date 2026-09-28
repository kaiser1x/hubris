"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  activeJobIdPreference,
  jobIdFromSearch,
  jobRepositoryContext,
  writeActiveJobId,
  type JobRepositoryContext,
} from "../lib/workspace";
import { fetchJobById, type LiveJob } from "../lib/live-twin";

export type WorkspaceStatus = "loading" | "ready" | "unavailable";

export interface WorkspaceContextValue {
  status: WorkspaceStatus;
  job: LiveJob | null;
  jobId: string | null;
  repo: JobRepositoryContext;
  // Explicitly select the active job. null clears the persisted selection
  // and re-resolves to the latest completed analysis.
  selectJob: (jobId: string | null) => void;
  reload: () => void;
}

const DEFAULT_CONTEXT: WorkspaceContextValue = {
  status: "loading",
  job: null,
  jobId: null,
  repo: jobRepositoryContext(null),
  selectJob: () => {},
  reload: () => {},
};

const WorkspaceContext = createContext<WorkspaceContextValue>(DEFAULT_CONTEXT);

export function useWorkspace(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}

// An explicit id is authoritative: a requested-but-missing job resolves to
// "no job" (unavailable), never silently to another job.
async function resolveJob(explicitId: string | null): Promise<LiveJob | null> {
  return explicitId ? fetchJobById(explicitId) : null;
}

export default function WorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [job, setJob] = useState<LiveJob | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const applyJob = useCallback(async (next: LiveJob | null) => {
    if (next) {
      writeActiveJobId(next.id, window.localStorage);
      jobIdRef.current = next.id;
      setJob(next);
      setStatus("ready");
    } else {
      writeActiveJobId(null, window.localStorage);
      jobIdRef.current = null;
      setJob(null);
      setStatus("unavailable");
    }
  }, []);

  const selectJob = useCallback(
    async (jobId: string | null) => {
      const requestId = ++requestRef.current;
      setStatus("loading");
      const next = await resolveJob(jobId);
      if (requestId !== requestRef.current) return;
      await applyJob(next);
    },
    [applyJob]
  );

  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    setStatus("loading");
    const explicit = activeJobIdPreference(new URLSearchParams(window.location.search), window.localStorage);
    const next = await resolveJob(explicit);
    if (requestId !== requestRef.current) return;
    await applyJob(next);
  }, [applyJob]);

  // Initial resolution: URL > persisted active job > latest completed job.
  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestRef.current;
    (async () => {
      const explicit = activeJobIdPreference(new URLSearchParams(window.location.search), window.localStorage);
      const next = await resolveJob(explicit);
      if (cancelled || requestId !== requestRef.current) return;
      await applyJob(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyJob]);

  // Keep the URL-driven job authoritative across in-workspace navigation.
  const onUrlJobId = useCallback(
    (urlJobId: string | null) => {
      if (urlJobId && jobIdRef.current !== urlJobId) void selectJob(urlJobId);
    },
    [selectJob]
  );

  const repo = jobRepositoryContext(job);
  const value: WorkspaceContextValue = {
    status,
    job,
    jobId: job?.id ?? null,
    repo,
    selectJob: (id: string | null) => void selectJob(id),
    reload: () => void reload(),
  };

  return (
    <WorkspaceContext.Provider value={value}>
      <Suspense fallback={null}>
        <UrlJobSync onJobId={onUrlJobId} />
      </Suspense>
      {children}
    </WorkspaceContext.Provider>
  );
}

// Renders nothing; reports the ?jobId= search param to the provider so an
// explicit id in the URL stays authoritative during client navigation.
function UrlJobSync({ onJobId }: { onJobId: (jobId: string | null) => void }) {
  const searchParams = useSearchParams();
  const jobId = jobIdFromSearch(searchParams);
  useEffect(() => {
    onJobId(jobId);
  }, [jobId, onJobId]);
  return null;
}
