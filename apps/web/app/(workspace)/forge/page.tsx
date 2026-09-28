"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ForgeRunPanel from "../../components/ForgeRunPanel";
import ForgeHistoryPanel from "../../components/ForgeHistoryPanel";
import ForgeRunDrawer from "../../components/ForgeRunDrawer";
import ForgeNoInvestigation from "../../components/ForgeNoInvestigation";
import InvestigationSummary from "../../components/InvestigationSummary";
import Link from "next/link";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { fetchJobById } from "../../lib/live-twin";
import { jobSourceRef } from "../../lib/forge-run";
import { workspaceHref } from "../../lib/workspace";
import {
  buildForgeBody,
  canForgePlan,
  canReviewInvestigation,
  composeForgeFocus,
  findRunForInvestigation,
  findRunView,
  findSavedInvestigation,
  investigationReviewHref,
  resolveForgeRuns,
  STRUCTURED_VERIFY_PATH,
  toVerifyError,
  type ForgeRunView,
  type InvestigationView,
} from "../../lib/forge-run";

export default function ForgePage() {
  return (
    <Suspense fallback={null}>
      <ForgePageContent />
    </Suspense>
  );
}

function ForgePageContent() {
  const { status, job, jobId, repo } = useWorkspace();
  const searchParams = useSearchParams();
  // The investigation this Forge run is bound to, loaded by exact id from the
  // persisted InvestigationRun. Never inferred from prompt text, the target,
  // the URL alone, or the most recent investigation.
  const [investigationId, setInvestigationId] = useState<string | null>(null);
  const [investigation, setInvestigation] = useState<InvestigationView | null>(null);
  const [loadingInvestigation, setLoadingInvestigation] = useState(true);
  const [investigationError, setInvestigationError] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [historyRun, setHistoryRun] = useState<ForgeRunView | null>(null);
  const [forging, setForging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ForgeRunView[] | null>(null);
  const [runsJob, setRunsJob] = useState<string | null>(null);
  const [runsChecked, setRunsChecked] = useState(false);

  const loadRuns = useCallback(async (): Promise<Awaited<ReturnType<typeof fetchJobById>>> => {
    setRunsChecked(false);
    try {
      if (!jobId) {
        setRuns([]);
        setRunsJob(null);
        setRunsChecked(true);
        return null;
      }
      const exactJob = await fetchJobById(jobId);
      if (!exactJob) {
        setRuns([]);
        setRunsJob(null);
      } else {
        const views = resolveForgeRuns(exactJob).slice().reverse();
        setRuns(views);
        const source = jobSourceRef(exactJob);
        setRunsJob(
          `${exactJob.result?.repository?.name ?? "unknown repository"} · ${exactJob.id.slice(0, 8)} · src: ${source ?? "default branch"}`
        );
      }
      return exactJob;
    } catch {
      setRuns([]);
      setRunsJob(null);
      return null;
    } finally {
      setRunsChecked(true);
    }
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const requested = searchParams.get("investigationId");
      const requestedJobId = searchParams.get("jobId");
      if (requestedJobId && requestedJobId !== jobId) return;
      setInvestigationId(requested);
      setInvestigation(null);
      setInvestigationError(null);
      setLoadingInvestigation(Boolean(requested));
      setCurrentRunId(null);
      setHistoryRun(null);
      const runsJob = await loadRuns();
      const exactJob = runsJob;
      if (cancelled) return;
      if (!requested) {
        setLoadingInvestigation(false);
        return;
      }
      if (!exactJob) {
        setInvestigationError("The investigation's job could not be loaded.");
        setLoadingInvestigation(false);
        return;
      }
      const saved = findSavedInvestigation(exactJob, requested);
      if (canReviewInvestigation(saved)) {
        setInvestigation(saved);
        // Display an already-forged run bound to this exact investigation.
        // This is read-only: no Forge run is launched on load. Refresh and
        // navigation never POST; only the explicit button starts a run.
        const existing = findRunForInvestigation(
          resolveForgeRuns(exactJob).slice().reverse(),
          requested
        );
        if (existing) setCurrentRunId(existing.id);
      } else {
        setInvestigationError("The requested READY investigation could not be loaded.");
      }
      setLoadingInvestigation(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, loadRuns, searchParams]);

  // Forge consumes the bound investigation. It never re-runs investigation.
  async function forgeFix() {
    const boundJobId = investigation?.jobId ?? jobId;
    if (!boundJobId || forging) return;
    const plan = investigation?.status === "READY" ? investigation.plan : null;
    const prepared = buildForgeBody(
      boundJobId,
      investigationId,
      plan ? composeForgeFocus(plan) : ""
    );
    if (!prepared.ok) {
      setActionError(prepared.error);
      return;
    }
    setForging(true);
    setActionError(null);
    setCurrentRunId(null);
    try {
      const res = await fetch(STRUCTURED_VERIFY_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const data = await res.json();
      const runId =
        res.ok && data && typeof data.forgeRun === "object" && data.forgeRun !== null
          ? (data.forgeRun as { id?: unknown }).id
          : null;
      if (typeof runId !== "string" || runId.length === 0) {
        setActionError(toVerifyError(res.status, data));
        return;
      }
      await loadRuns();
      setCurrentRunId(runId);
    } catch {
      setActionError("Analysis service unreachable. Is the API running?");
    } finally {
      setForging(false);
    }
  }

  const current = currentRunId ? findRunView(runs ?? [], currentRunId) : null;
  const currentPaths = current ? [...new Set(current.edits.map((e) => e.path))] : [];

  if (status === "loading") {
    return (
      <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Forge</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading workspace…
        </p>
      </div>
    );
  }

  if (!jobId || !job) {
    return (
      <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Forge</p>
        <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
          No analyzed repository
        </h1>
        <p className="font-mono text-[13px] text-[#7A7171] mt-3 max-w-xl leading-7">
          Forge generates a minimal patch from a grounded investigation
          against the analyzed repository. Analyze a repository and run an
          investigation first.
        </p>
        <Link
          href={workspaceHref("/codebase", { jobId })}
          className="inline-flex mt-7 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] transition-all"
        >
          ANALYZE REPOSITORY ↗
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">
        Repository / Forge{repo.hasContext ? ` · live · ${repo.repoName}` : ""}
      </p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Proposed patch
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        {current && currentPaths.length > 0
          ? `${currentPaths.join(", ")} · structured edit · run ${current.id.slice(0, 8)}`
          : "a patch is forged from the attached investigation"}
      </p>

      <section className="mt-10">
        <div className="flex items-end justify-between gap-4 border-b border-[#dedada] pb-4">
          <p className="kicker">Based on Investigation</p>
          {investigation?.status === "READY" && (
            <span className="hubris-status hubris-status-ready">READY</span>
          )}
        </div>

        {loadingInvestigation ? (
          <p className="font-mono text-[13px] text-[#7A7171] mt-5">
            Loading investigation…
          </p>
        ) : !investigationId ? (
          <ForgeNoInvestigation jobId={jobId} />
        ) : investigationError || !investigation ? (
          <ForgeNoInvestigation
            jobId={jobId}
            title="Investigation unavailable"
            detail={
              investigationError ??
              "The attached investigation could not be loaded."
            }
          />
        ) : (
          <>
            <div className="mt-5">
              <InvestigationSummary investigation={investigation} repo={repo} />
            </div>
            <div className="flex items-center gap-4 mt-4">
              <button
                type="button"
                onClick={() => void forgeFix()}
                disabled={!canForgePlan(investigation) || forging}
                className="bg-[#0A0A0A] px-4 py-3 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 transition-all"
              >
                {forging ? "FORGING…" : "FORGE FIX IN SANDBOX ↗"}
              </button>
              <Link
                href={investigationReviewHref(investigation.jobId ?? jobId, investigationId)}
                className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] underline underline-offset-4 decoration-[#dedada]"
              >
                VIEW INVESTIGATION ↗
              </Link>
            </div>

            {actionError && (
              <p role="alert" className="font-mono text-xs mt-4 underline underline-offset-4 decoration-[#dedada]">
                {actionError}
              </p>
            )}

            {forging && (
              <p className="font-mono text-[13px] text-[#7A7171] mt-4">
                Forging the verified plan in a disposable sandbox…
              </p>
            )}

            <div className="mt-8">
              <p className="kicker">Proposed patch</p>
              {current ? (
                <div className="mt-4">
                  <ForgeRunPanel run={current} />
                </div>
              ) : (
                <div className="border border-[#dedada] px-5 py-5 mt-4">
                  <p className="kicker">Patch not generated yet</p>
                  <p className="font-mono text-[12px] mt-3 leading-6 text-[#7A7171]">
                    Nothing is forged automatically. Click FORGE FIX IN SANDBOX
                    to generate and verify a patch from the attached
                    investigation. Refreshing this page never starts a run.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-8">
              <p className="kicker">Validation</p>
              {current?.verification ? (
                <p className="font-mono text-[12px] text-[#7A7171] mt-3">
                  Regression suite:{" "}
                  {current.verification.assessment
                    ? current.verification.assessment.fullSuitePassed
                      ? "PASSED"
                      : "FAILED"
                    : current.verification.result}{" "}
                  · exit {current.verification.exitCode ?? "—"}
                </p>
              ) : (
                <p className="font-mono text-[12px] text-[#7A7171] mt-3">
                  No verification run yet.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <ForgeHistoryPanel
        runs={runs ?? []}
        runsJob={runsJob}
        runsChecked={runsChecked}
        onRefresh={() => void loadRuns()}
        onSelect={(run) => setHistoryRun(run)}
      />
      <ForgeRunDrawer run={historyRun} onClose={() => setHistoryRun(null)} />
    </div>
  );
}
