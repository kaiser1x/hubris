"use client";

import { useEffect, useState } from "react";
import { fetchLatestJob } from "../lib/live-twin";
import { jobRepositoryContext } from "../lib/workspace";

// Repository-aware status line for the landing page. Shows the most recent
// completed analysis's repository identity when one exists; otherwise a
// neutral "workspace ready" line. Never a hardcoded demo repository.
export function LandingSyncLine() {
  const [line, setLine] = useState("TWIN SYNCED · WORKSPACE READY");
  useEffect(() => {
    let cancelled = false;
    void fetchLatestJob().then((job) => {
      if (cancelled || !job) return;
      const ctx = jobRepositoryContext(job);
      if (ctx.hasContext) {
        setLine(`TWIN SYNCED · ${ctx.repoName} · ${ctx.ref ?? "main"}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return <>{line}</>;
}

export interface LandingStat {
  label: string;
  value: string;
  sub: string;
}

const GENERIC_STATS: LandingStat[] = [
  ["Understand", "Twin", "maps the repo into a dependency graph"],
  ["Trace", "Call chain", "built from the analyzed CodeTwin"],
  ["Verify", "Evidence", "reproductions and checks, persisted"],
  ["Forge", "Patch", "minimal and grounded in the repo"],
].map(([label, value, sub]) => ({ label, value, sub }));

// Live health stats from the latest completed analysis when one exists;
// otherwise honest generic value props — never fabricated repository counts.
export function LandingStats() {
  const [stats, setStats] = useState<LandingStat[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchLatestJob().then((job) => {
      if (cancelled || !job) return;
      const s = job.result?.stats;
      if (!s) return;
      setStats([
        {
          label: "Functions mapped",
          value: String(s.functions + s.classes),
          sub: `${s.endpoints} endpoints`,
        },
        {
          label: "Relationships",
          value: String(s.relationships),
          sub: "traced across files",
        },
        {
          label: "Tests found",
          value: String(s.tests),
          sub: "linked to nodes",
        },
        {
          label: "Analysis",
          value: `${Math.max(1, Math.round((s.analysisMs ?? 0) / 1000))}s`,
          sub: "last completed run",
        },
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const cells = stats ?? GENERIC_STATS;
  return (
    <div className="border-y border-[#dedada] grid grid-cols-2 md:grid-cols-4">
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={`py-5 pr-5 ${i > 0 ? "md:pl-5 md:border-l md:border-[#dedada]" : ""} ${i === 2 ? "max-md:border-l max-md:pl-5" : ""}`}
        >
          <p className="kicker">{c.label}</p>
          <p className="font-display text-[34px] leading-none mt-3">
            {c.value}
          </p>
          <p className="font-mono text-[11px] text-[#7A7171] mt-2">
            {c.sub}
          </p>
        </div>
      ))}
    </div>
  );
}