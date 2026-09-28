"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJobById, type LiveJob } from "../../lib/live-twin";
import { buildHistoryEntries, type HistoryEntry } from "../../lib/history";
import { useWorkspace } from "../../components/WorkspaceProvider";

export default function HistoryPage() {
  const { status, job, repo } = useWorkspace();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!job?.id) {
      setEntries([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    void fetchJobById(job.id).then((exactJob: LiveJob | null) => {
      if (cancelled) return;
      setEntries(buildHistoryEntries(exactJob ? [exactJob] : []));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [job?.id]);

  return (
    <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / History{repo.hasContext ? ` - ${repo.repoName}` : ""}</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">History</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[#7A7171]">
        Read-only records of investigations and Forge runs persisted against analyzed repositories.
      </p>
      {status === "loading" || loading ? (
        <p className="mt-10 font-mono text-[13px] text-[#7A7171]">Loading persisted history…</p>
      ) : entries.length === 0 ? (
        <div className="mt-10 border-t border-[#dedada] pt-5">
          <p className="kicker">No persisted records</p>
          <p className="mt-3 font-mono text-[12px] leading-6 text-[#7A7171]">
            Investigations and Forge runs will appear here after they are persisted.
          </p>
        </div>
      ) : (
        <div className="mt-10 border-t border-[#dedada]">
          {entries.map((entry) => (
            <article key={`${entry.kind}-${entry.id}`} className="grid gap-4 border-b border-[#dedada] py-5 md:grid-cols-[150px_1fr_auto] md:items-start">
              <div>
                <span className="hubris-status">{entry.kind}</span>
                <p className="mt-2 font-mono text-[10px] text-[#7A7171]">{entry.status}</p>
              </div>
              <div className="min-w-0">
                <p className="font-mono text-[12px] text-[#7A7171]">{entry.repository} · job {entry.jobId.slice(0, 8)}</p>
                {entry.target && <p className="mt-2 font-mono text-[13px]">{entry.target}</p>}
                <p className="mt-2 max-w-3xl text-[13px] leading-6 text-[#7A7171]">{entry.detail}</p>
                {entry.verification && <p className="mt-2 font-mono text-[11px]">Verification · {entry.verification}</p>}
              </div>
              <div className="flex items-center gap-4 md:justify-end">
                <span className="font-mono text-[10px] text-[#7A7171]">{entry.at ?? "—"}</span>
                <Link href={entry.href} className="font-mono text-[10px] tracking-[0.08em] underline underline-offset-4 decoration-[#dedada] hover:text-[#7A7171]">
                  OPEN ↗
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
