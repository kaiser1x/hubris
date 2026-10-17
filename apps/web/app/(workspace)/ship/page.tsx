"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { fetchJobById, type LiveJob } from "../../lib/live-twin";
import { jobRepositoryContext, workspaceHref } from "../../lib/workspace";
import {
  buildShipBody,
  resolveForgeRuns,
  shipBaseDescription,
  shipBranchPreview,
  shipEligible,
  shipTitlePreview,
  SHIP_PATH,
  targetVerificationMark,
  type ForgeRunView,
  type PullRequestView,
} from "../../lib/forge-run";

export default function ShipPage() {
  return (
    <Suspense fallback={null}>
      <ShipPageContent />
    </Suspense>
  );
}

function ShipPageContent() {
  const { status, jobId: workspaceJobId } = useWorkspace();
  const searchParams = useSearchParams();
  const requestedJobId = searchParams.get("jobId");
  const requestedRunId = searchParams.get("forgeRunId");
  // The exact job the run belongs to: the URL jobId is authoritative, else the
  // workspace's active job.
  const jobId = requestedJobId ?? workspaceJobId;

  const [job, setJob] = useState<LiveJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);
  const [shipped, setShipped] = useState<PullRequestView | null>(null);
  // Result state from the last ship attempt: "PR_CREATED" | "PR_EXISTS" |
  // "NOT_READY" | "ACTION_REQUIRED" | null.
  const [apiState, setApiState] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setJob(null);
    setConfirming(false);
    setShipError(null);
    setShipped(null);
    setApiState(null);
    setPushStatus(null);
    if (!jobId) {
      setLoading(false);
      return;
    }
    void (async () => {
      const exact = await fetchJobById(jobId);
      if (cancelled) return;
      if (!exact) {
        setLoadError("The analysis job could not be loaded.");
      } else {
        setJob(exact);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Public demo: PR creation is refused server-side for anonymous sessions;
  // say so up front instead of offering a button that cannot work.
  const [demoMode, setDemoMode] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/demo")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!cancelled) setDemoMode(typeof d === "object" && d !== null && (d as { demo?: unknown }).demo === true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Bind to the EXACT Forge run by id. No latest/first-eligible fallback.
  const runs = job ? resolveForgeRuns(job) : [];
  const run: ForgeRunView | null = requestedRunId
    ? runs.find((r) => r.id === requestedRunId) ?? null
    : null;

  const eligibility = shipEligible(run);
  const assessment = run?.verification?.assessment ?? null;
  const pr = shipped ?? run?.pullRequest ?? null;
  const exactRepo = jobRepositoryContext(job);
  const targetFunction = run?.edits[0]?.function ?? "";
  const targetFile = run?.edits[0]?.path ?? "";
  const report = run?.focus ?? "";
  const shipBase = shipBaseDescription(run, job);
  const branchPreview = run ? shipBranchPreview(targetFunction, report, run.investigationId) : "";
  const titlePreview = run ? shipTitlePreview(targetFunction, report) : "";

  // Colour-coded ship status: green = ready, red = not ready, yellow = action
  // required (authorization). Never text-only — a colored dot + left border.
  const blockedByState = apiState === "ACTION_REQUIRED";
  const notReady = apiState === "NOT_READY" || (!eligibility.eligible && !pr && !blockedByState);
  const gauge: "green" | "yellow" | "red" = pr ? "green" : blockedByState ? "yellow" : notReady ? "red" : "green";
  const gaugeColor = gauge === "green" ? "#1a7f37" : gauge === "yellow" ? "#9a6700" : "#b42318";
  const statusLabel = pr
    ? shipped
      ? "PULL REQUEST CREATED"
      : "PULL REQUEST ALREADY EXISTS"
    : blockedByState
      ? "GitHub authorization required"
      : notReady
        ? "NOT READY"
        : "READY FOR PULL REQUEST";
  const statusDetail = pr
    ? pushStatus === "ALREADY_PUSHED"
      ? "Branch is already pushed and matches the verified repair."
      : "Verified repair branch was pushed successfully."
    : blockedByState
      ? shipError ?? "Configure a GitHub token with permission to create pull requests."
      : notReady
        ? shipError ?? eligibility.reason
        : "The verified repair is ready to publish as a GitHub Pull Request.";

  async function ship() {
    const prepared = buildShipBody(jobId ?? "", run?.id ?? null);
    if (!prepared.ok) {
      setShipError(prepared.error);
      return;
    }
    setShipping(true);
    setShipError(null);
    try {
      const res = await fetch(SHIP_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const data = await res.json();
      if (!res.ok || !data.pullRequest) {
        setApiState(typeof data.state === "string" ? data.state : "NOT_READY");
        setShipError(data.error ?? "Pull request creation failed.");
        return;
      }
      setShipped(data.pullRequest as PullRequestView);
      setPushStatus(typeof data.pushStatus === "string" ? data.pushStatus : null);
      setApiState(typeof data.state === "string" ? data.state : "PR_CREATED");
      setConfirming(false);
    } catch {
      setShipError("Analysis service unreachable. Is the API running?");
    } finally {
      setShipping(false);
    }
  }

  if (status === "loading" || loading) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Ship</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">Loading verified repair…</p>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Ship</p>
        <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
          No analyzed repository
        </h1>
        <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
          Ship publishes a verified Forge repair as a GitHub Pull Request. Analyze a
          repository, forge a repair, and verify it first.
        </p>
      </div>
    );
  }

  const backToForge = (
    <Link
      href={workspaceHref("/forge", { jobId })}
      className="inline-flex mt-4 border border-[#0A0A0A] px-4 py-3 font-mono text-[11px] tracking-[0.08em] hover:bg-white"
    >
      GO TO FORGE ↗
    </Link>
  );

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">
        Repository / Ship{exactRepo.hasContext ? ` · ${exactRepo.repoName}` : ""}
      </p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Publish verified repair
      </h1>
      <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
        Ship opens a GitHub Pull Request from the exact repair HUBRIS verified. HUBRIS
        never merges; a human reviews and merges.
      </p>

      {loadError ? (
        <div className="mt-8 max-w-2xl border border-[#dedada] px-5 py-5">
          <p className="kicker">Repair unavailable</p>
          <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">{loadError}</p>
          {backToForge}
        </div>
      ) : !requestedRunId ? (
        <div className="mt-8 max-w-2xl border border-[#dedada] px-5 py-5">
          <p className="kicker">No Forge run selected</p>
          <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">
            Ship is bound to a specific verified Forge run. Open it from the Forge page
            with SHIP VERIFIED REPAIR.
          </p>
          {backToForge}
        </div>
      ) : !run ? (
        <div className="mt-8 max-w-2xl border border-[#dedada] px-5 py-5">
          <p className="kicker">Forge run not found on this job.</p>
          <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">
            The requested Forge run could not be found on the selected analysis job.
          </p>
          {backToForge}
        </div>
      ) : (
        <>
          <section className="mt-8 max-w-2xl border border-[#dedada] bg-white/60 px-5 py-5">
            <p className="font-display text-[26px] leading-none">
              {eligibility.eligible
                ? "VERIFIED REPAIR READY TO SHIP"
                : "REPAIR NOT READY TO SHIP"}
            </p>
            {run.edits.length > 0 && (
              <p className="font-mono text-[12px] mt-3">
                Target: <span className="text-[#0A0A0A]">{targetFile}</span> →{" "}
                <span className="text-[#0A0A0A]">{targetFunction}()</span>
              </p>
            )}

            <dl className="font-mono text-xs mt-4 border-t border-[#dedada]">
              {assessment?.targetScenario && (
                <div className="flex justify-between gap-4 py-1.5 border-b border-[#dedada]">
                  <dt className="text-[#7A7171] shrink-0">Target verification</dt>
                  <dd className="text-right">
                    <span>
                      {targetVerificationMark(assessment.targetVerificationPassed)}{" "}
                      {assessment.targetScenario}
                    </span>
                    {assessment.targetTestFile && (
                      <span className="block text-[10px] text-[#7A7171] break-all">
                        {assessment.targetTestFile}
                      </span>
                    )}
                  </dd>
                </div>
              )}
              <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                <dt className="text-[#7A7171]">Patch</dt>
                <dd>{run.applyApplied ? "✓ Applied" : "✗ Not applied"}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                <dt className="text-[#7A7171]">Assessment</dt>
                <dd>{run.outcome.replace(/_/g, " ")}</dd>
              </div>
              <div className="flex justify-between gap-4 py-1.5">
                <dt className="text-[#7A7171] shrink-0">Regression suite</dt>
                <dd className="text-right">
                  {assessment?.fullSuitePassed
                    ? "✓ PASSED"
                    : assessment
                      ? `✗ ${assessment.unrelatedTestFailures} unrelated tests failed`
                      : "—"}
                </dd>
              </div>
            </dl>

            {assessment && assessment.failedTests.length > 0 && (
              <div className="font-mono text-[11px] mt-2 text-[#7A7171]">
                <p>Unrelated:</p>
                <ul className="break-all">
                  {assessment.failedTests.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section
            className="mt-6 max-w-2xl border border-[#dedada] px-5 py-4"
            style={{ borderLeft: `4px solid ${gaugeColor}` }}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: gaugeColor }}
              />
              <p className="font-mono text-[11px] tracking-[0.08em]">{statusLabel}</p>
            </div>
            {statusDetail && (
              <p className="font-mono text-[11px] leading-5 text-[#7A7171] mt-2">{statusDetail}</p>
            )}
          </section>

          <section className="mt-6 max-w-2xl border border-[#dedada] px-5 py-5">
            <p className="kicker">HUBRIS provenance</p>
            <dl className="font-mono text-[11px] mt-3">
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Forge run ID</dt><dd className="break-all text-right">{run.id}</dd></div>
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Investigation ID</dt><dd className="break-all text-right">{run.investigationId ?? "—"}</dd></div>
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Analyzed ref</dt><dd className="break-all text-right">{shipBase.label}</dd></div>
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Analyzed commit</dt><dd className="break-all text-right">{run.source.analysisCommitSha ?? "—"}</dd></div>
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Execution commit</dt><dd className="break-all text-right">{run.source.executionCommitSha ?? "—"}</dd></div>
              <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Canonical patch SHA</dt><dd className="break-all text-right">{run.patchSha ?? "—"}</dd></div>
            </dl>
          </section>

          {pr ? (
            <section className="mt-8 max-w-2xl border-2 border-[#0A0A0A] px-5 py-5">
              <p className="font-display text-[26px] leading-none">
                {shipped ? "PULL REQUEST CREATED" : "PULL REQUEST ALREADY EXISTS"}
              </p>
              <p className="font-mono text-[12px] mt-3">{titlePreview}</p>
              {shipped && (
                <p className="font-mono text-[11px] text-[#7A7171] mt-2">
                  {pushStatus === "ALREADY_PUSHED"
                    ? "Branch is already pushed and matches the verified repair."
                    : "Verified repair branch was pushed successfully."}
                </p>
              )}
              <dl className="font-mono text-xs mt-3 border-t border-[#dedada]">
                <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                  <dt className="text-[#7A7171]">Branch</dt>
                  <dd className="break-all text-right">{pr.branch}</dd>
                </div>
                <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                  <dt className="text-[#7A7171]">Pull request base</dt>
                  <dd className="break-all text-right">{pr.baseBranch}</dd>
                </div>
                <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                  <dt className="text-[#7A7171]">Target verification</dt>
                  <dd>
                    {assessment?.targetVerificationPassed === true
                      ? "✓ Passed"
                      : assessment?.targetVerificationPassed === false
                        ? "✗ Failed"
                        : "— Not confirmed"}
                  </dd>
                </div>
                <div className="flex justify-between py-1.5">
                  <dt className="text-[#7A7171]">Regression suite</dt>
                  <dd>
                    {assessment?.fullSuitePassed
                      ? "✓ Passed"
                      : `✗ ${assessment?.unrelatedTestFailures ?? 0} unrelated failures`}
                  </dd>
                </div>
              </dl>
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex mt-4 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] transition-all"
              >
                VIEW PULL REQUEST ↗
              </a>
              <p className="font-mono text-[10px] text-[#7A7171] mt-3">
                HUBRIS does not merge. Review and merge on GitHub.
              </p>
            </section>
          ) : (
            <section className="mt-8 max-w-2xl border border-[#dedada] px-5 py-5">
              <p className="kicker">Ship repair</p>
              <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">
                This will create a GitHub branch and Pull Request. HUBRIS will not merge
                the Pull Request.
              </p>
              {!eligibility.eligible && (
                <p className="font-mono text-[11px] mt-3 text-[#7A7171]">{eligibility.reason}</p>
              )}
              {shipError && (
                <p role="alert" className="font-mono text-xs mt-3 underline underline-offset-4 decoration-[#dedada]">
                  {shipError}
                </p>
              )}
              {demoMode && (
                <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3" data-demo-ship-disabled>
                  Public demo: opening pull requests is disabled. The verified patch and its
                  provenance above are the result; shipping requires an authenticated operator.
                </p>
              )}
              {confirming && !demoMode ? (
                <div className="mt-4 border border-[#dedada] px-4 py-4">
                  <p className="font-mono text-[12px]">CREATE PULL REQUEST?</p>
                  <p className="font-mono text-[11px] leading-6 text-[#7A7171] mt-2">
                    This will push the verified repair to a new <code>hubris/*</code> branch and
                    open a GitHub Pull Request. It will not modify or merge the base branch.
                  </p>
                  <dl className="font-mono text-[11px] mt-3">
                    <div className="flex justify-between py-1"><dt className="text-[#7A7171]">Repository</dt><dd>{exactRepo.repoName ?? "—"}</dd></div>
                    <div className="flex justify-between py-1 gap-4"><dt className="text-[#7A7171] shrink-0">Pull request base</dt><dd className="break-all text-right">{shipBase.label}</dd></div>
                    <div className="flex justify-between py-1 gap-4"><dt className="text-[#7A7171] shrink-0">Branch</dt><dd className="break-all text-right">{branchPreview}</dd></div>
                    <div className="flex justify-between py-1 gap-4"><dt className="text-[#7A7171] shrink-0">Commit</dt><dd className="break-all text-right">{titlePreview}</dd></div>
                  </dl>
                  <div className="flex items-center gap-3 mt-4">
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      disabled={shipping}
                      className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] disabled:opacity-40"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => void ship()}
                      disabled={shipping}
                      className="bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] disabled:opacity-40 transition-all"
                    >
                      {shipping ? "CREATING…" : "CREATE PULL REQUEST"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!eligibility.eligible || demoMode}
                  className="inline-flex mt-4 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 transition-all"
                >
                  CREATE PULL REQUEST
                </button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
