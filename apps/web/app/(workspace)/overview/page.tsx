"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { resolveLiveOverview } from "../../lib/live-twin";
import { findSavedInvestigation, toInvestigation } from "../../lib/forge-run";
import type { TwinNode } from "../../lib/casefile";
import { workspaceHref } from "../../lib/workspace";

export default function OverviewPage() {
  const { status, job, repo } = useWorkspace();

  const live = useMemo(() => resolveLiveOverview(job), [job]);

  const investigations = useMemo(() => {
    if (!job?.result || !Array.isArray(job.result.investigationRuns)) return [];
    const views = job.result.investigationRuns
      .map((raw) => toInvestigation(raw))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    return [...views].reverse();
  }, [job]);

  const latestFinding = useMemo(
    () => (job ? findSavedInvestigation(job) : null),
    [job]
  );

  if (status === "loading") {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Overview</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading workspace…
        </p>
      </div>
    );
  }

  if (status === "unavailable" || !job) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Overview</p>
        <h1 className="font-display text-[clamp(38px,5vw,58px)] leading-[1.05] mt-4">
          No analyzed repository
        </h1>
        <p className="font-mono text-[13px] text-[#7A7171] mt-3 max-w-xl leading-7">
          The workspace has no completed analysis to render. Analyze a
          repository to see its live CodeTwin, open cases, and findings here.
        </p>
        <Link
          href={workspaceHref("/codebase", { jobId: job?.id })}
          className="inline-flex mt-7 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3.5 hover:bg-black active:scale-[0.98] transition-all"
        >
          ANALYZE REPOSITORY ↗
        </Link>
      </div>
    );
  }

  if (!live) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Overview</p>
        <h1 className="font-display text-[clamp(38px,5vw,58px)] leading-[1.05] mt-4">
          {repo.label}
        </h1>
        <p className="font-mono text-[13px] text-[#7A7171] mt-3 max-w-xl leading-7">
          {repo.hasContext
            ? "This job has no usable CodeTwin content. Re-analyze the repository to build the twin."
            : "Repository context is unavailable for this job. Re-analyze to restore the workspace."}
        </p>
      </div>
    );
  }

  const nodes: TwinNode[] = live.nodes;
  const healthCells = live.cells;
  const selectedNode = nodes[0];
  const finding = latestFinding;
  const findingPlan = finding?.plan ?? null;

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Overview</p>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4 mt-4">
        <div>
          <h1 className="font-display text-[clamp(38px,5vw,58px)] leading-[1.05]">
            {repo.hasContext ? repo.repoName : live.name}
          </h1>
          <p className="font-mono text-[13px] text-[#7A7171] mt-3">
            {repo.ref ? `ref ${repo.ref} · ` : ""}A living case file for your codebase.
          </p>
        </div>
        <Link
           href={workspaceHref("/codebase", { jobId: job.id })}
          className="sm:ml-auto shrink-0 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3.5 hover:bg-black active:scale-[0.98] transition-all"
        >
          ANALYZE REPOSITORY ↗
        </Link>
      </div>

      <section className="mt-12">
        <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
          <div>
            <p className="kicker">01 / System state</p>
            <h2 className="font-display text-[25px] mt-2">Codebase health</h2>
          </div>
          <span className="font-mono text-[10px] text-[#7A7171]">
            ANALYSIS COMPLETE ✓
          </span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-[#dedada]">
          {healthCells.map(([label, value, sub], i) => (
            <div
              key={label}
              className={`py-6 pr-5 ${i < 2 ? "pl-5 border-r border-[#dedada]" : "pl-5 max-lg:border-l max-lg:border-[#dedada]"} ${i === 0 ? "max-lg:border-l-0 max-lg:pl-0" : ""} max-lg:[&:nth-child(2)]:border-r-0`}
            >
              <p className="kicker">{label}</p>
              <p className="font-display text-[32px] mt-4">{value}</p>
              <p className="font-mono text-[10px] text-[#7A7171] mt-1.5">
                {sub}
              </p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-14 lg:grid-cols-[1.25fr_0.95fr] mt-[72px]">
        <section>
          <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
            <div>
              <p className="kicker">02 / Open cases</p>
              <h2 className="font-display text-[25px] mt-2">
                Active investigations
              </h2>
            </div>
             <Link
               href={workspaceHref("/investigate", { jobId: job.id })}
              className="font-mono text-[10px] tracking-[0.08em] text-[#0A0A0A] hover:underline underline-offset-4"
            >
              VIEW ALL ↗
            </Link>
          </div>
          <div className="border-b border-[#dedada]">
            {investigations.length === 0 ? (
              <p className="font-mono text-[12px] leading-6 text-[#7A7171] py-5">
                No investigations persisted for this job yet. Describe a
                suspected issue on the Investigate page to start one.
              </p>
            ) : (
              investigations.map((c) => {
                const target = c.plan?.target;
                return (
                  <Link
                    key={c.investigationId ?? c.status}
                    href={
                       c.investigationId
                         ? workspaceHref("/forge", { jobId: job.id, investigationId: c.investigationId })
                         : workspaceHref("/investigate", { jobId: job.id })
                    }
                    className="grid grid-cols-[9px_1fr_auto] gap-4 items-start py-5 border-b border-[#dedada] last:border-b-0 hover:bg-white/60 transition-colors"
                  >
                    <span
                      aria-hidden
                      className={`w-[7px] h-[7px] mt-1 border border-[#0A0A0A] ${
                        c.status === "READY"
                          ? "bg-[#0A0A0A]"
                          : "bg-transparent"
                      }`}
                    />
                    <span>
                      <strong className="block font-display text-[15px] font-normal">
                        {c.focus ?? "Investigation"}
                      </strong>
                      <span className="block font-mono text-[10px] text-[#7A7171] mt-1.5">
                        {target
                          ? `${target.file} · ${target.function}()`
                          : c.status}
                      </span>
                      <small className="block font-mono text-[10px] text-[#7A7171] mt-3">
                        {c.plan
                          ? `confidence ${c.plan.confidence} · ${c.plan.evidence.length} evidence`
                          : c.message ?? ""}
                      </small>
                    </span>
                    <span className="font-mono text-[10px] text-[#7A7171]">
                      {c.status} ›
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
            <div>
              <p className="kicker">03 / Codetwin</p>
              <h2 className="font-display text-[25px] mt-2">Architecture</h2>
            </div>
            <Link
              href={workspaceHref("/codebase", { jobId: job.id })}
              className="font-mono text-[10px] tracking-[0.08em] text-[#0A0A0A] hover:underline underline-offset-4"
            >
              OPEN ↗
            </Link>
          </div>
          <div
            className="mt-5 border border-[#dedada] px-4 py-5 font-mono text-[11px] leading-7"
            style={{
              backgroundImage: "radial-gradient(#d6d1d1 0.7px, transparent 0.7px)",
              backgroundSize: "13px 13px",
            }}
          >
            {nodes.slice(0, 8).map((n) => (
              <p key={n.id} className="truncate">
                <span className="text-[#7A7171]">{n.layer} / </span>
                {n.label}
              </p>
            ))}
            {nodes.length > 8 && (
              <p className="truncate text-[#7A7171]">
                + {nodes.length - 8} more in the codebase twin →
              </p>
            )}
          </div>
          <div className="border-t border-[#dedada] mt-4 pt-3.5 flex items-center justify-between">
            <div>
              <p className="kicker">Selected node</p>
              <p className="font-mono text-[13px] mt-1.5 truncate">
                {selectedNode ? `${selectedNode.file} · ${selectedNode.label}` : "—"}
              </p>
            </div>
            <span className="font-mono text-[10px] text-[#7A7171]">
              {selectedNode ? `${selectedNode.deps.length} dependencies ›` : ""}
            </span>
          </div>
        </section>
      </div>

      <section className="mt-[72px] pb-12">
        <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
          <div>
            <p className="kicker">04 / Latest finding</p>
            <h2 className="font-display text-[25px] mt-2">
              Evidence, not guesses.
            </h2>
          </div>
          {findingPlan && (
            <span className="font-mono text-[10px] text-[#0A0A0A]">
              ■ {findingPlan.confidence.toUpperCase()} CONFIDENCE
            </span>
          )}
        </div>
        {findingPlan ? (
          <div className="grid gap-9 lg:grid-cols-3 pt-7">
            <div>
              <p className="kicker">
                {findingPlan.target.function} /{" "}
                {finding?.focus?.slice(0, 80) ?? "Investigation"}
              </p>
              <h3 className="font-display text-[24px] leading-[1.15] mt-4">
                {findingPlan.summary}
              </h3>
              <p className="font-mono text-xs leading-6 text-[#7A7171] mt-4">
                {findingPlan.currentBehavior}
              </p>
              <p className="border-t border-[#dedada] mt-7 pt-3 flex items-baseline gap-3">
                <strong className="font-display text-[30px] font-normal">
                  {findingPlan.evidence.length}
                </strong>
                <span className="font-mono text-[10px] text-[#7A7171]">
                  evidence lines support this hypothesis
                </span>
              </p>
            </div>
            <div className="bg-[#111] text-[#d8d4d4] font-mono text-[11px] leading-[2.1] pb-4 self-start w-full overflow-x-auto">
              <div className="flex justify-between border-b border-[#393535] px-3.5 py-2.5 text-[10px] text-[#938c8c]">
                <span>{findingPlan.target.file}</span>
                <span>{findingPlan.target.function}()</span>
              </div>
              <div className="px-3.5">
                {findingPlan.evidence.slice(0, 6).map((line) => (
                  <p key={line} className="truncate">
                    · {line}
                  </p>
                ))}
              </div>
            </div>
            <div className="lg:border-l lg:border-[#dedada] lg:pl-6">
              <p className="kicker">Supporting evidence</p>
              {findingPlan.evidence.slice(0, 3).map((t) => (
                <Link
                  key={t}
                  href={
                      finding?.investigationId
                       ? workspaceHref("/forge", { jobId: job.id, investigationId: finding.investigationId })
                       : workspaceHref("/investigate", { jobId: job.id })
                  }
                  className="w-full flex items-center gap-3 border-b border-[#dedada] py-4 text-left hover:bg-white/60 transition-colors"
                >
                  <span className="font-mono text-[11px]">
                    {t}
                    <small className="block text-[#7A7171] text-[10px] mt-1">
                      {findingPlan.target.file}
                    </small>
                  </span>
                  <span className="ml-auto text-[#7A7171]">›</span>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <p className="font-mono text-[12px] leading-6 text-[#7A7171] pt-6">
            No READY investigation exists for this repository yet. Run an
            investigation on the Investigate page and its grounded finding
            will appear here.
          </p>
        )}
      </section>
    </div>
  );
}
