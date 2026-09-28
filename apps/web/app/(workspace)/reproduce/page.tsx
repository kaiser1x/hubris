"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { fetchJobById } from "../../lib/live-twin";
import {
  buildReproduceBody,
  canReviewInvestigation,
  findSavedInvestigation,
  type ReadyInvestigationView,
} from "../../lib/forge-run";
import { suggestReproduction, type ReproductionSuggestion } from "../../lib/reproduction";
import { workspaceHref } from "../../lib/workspace";

type RunState = "idle" | "running" | "done";

interface Evidence {
  script: string;
  requestedCommand?: string;
  command: string;
  executedCommand?: string | null;
  outcome: "REPRODUCED" | "NOT_REPRODUCED" | "SETUP_FAILED" | "EXECUTION_FAILED" | "TIMEOUT";
  reason: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  packageManager: string | null;
  installStatus: string | null;
  setup?: { status: string; reason?: string };
  execution?: { status: string; command?: string; exitCode?: number | null };
  durationMs?: number;
  investigationId?: string | null;
  source?: {
    analysisRef?: string | null;
    analysisCommitSha?: string | null;
    executionCommitSha?: string | null;
  };
}

const OUTCOME_COPY: Record<Evidence["outcome"], { title: string; detail: string }> = {
  REPRODUCED: { title: "REPRODUCED", detail: "Failure reproduced in isolated sandbox." },
  NOT_REPRODUCED: { title: "NOT REPRODUCED", detail: "Script completed, but the reported failure was not observed." },
  SETUP_FAILED: { title: "SETUP FAILED", detail: "Sandbox could not be prepared." },
  EXECUTION_FAILED: { title: "EXECUTION FAILED", detail: "Reproduction command failed to execute." },
  TIMEOUT: { title: "TIMEOUT", detail: "Reproduction exceeded the configured timeout." },
};

export default function ReproducePage() {
  return (
    <Suspense fallback={null}>
      <ReproducePageContent />
    </Suspense>
  );
}

function ReproducePageContent() {
  const { status, job, repo } = useWorkspace();
  const searchParams = useSearchParams();
  const jobId = job?.id ?? null;
  const requestedJobId = searchParams.get("jobId");
  const requestedInvestigationId = searchParams.get("investigationId");
  const jobRepo = repo.hasContext ? repo.repoName : null;
  const [run, setRun] = useState<RunState>("idle");
  const [script, setScript] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [investigation, setInvestigation] = useState<ReadyInvestigationView | null>(null);
  const [suggestion, setSuggestion] = useState<ReproductionSuggestion | null>(null);
  const [loadingInvestigation, setLoadingInvestigation] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRun("idle");
    setScript("");
    setEvidence(null);
    setRunError(null);
    setInvestigation(null);
    setSuggestion(null);
    if (!jobId || !requestedInvestigationId || (requestedJobId && requestedJobId !== jobId)) return;
    setLoadingInvestigation(true);
    void (async () => {
      const exactJob = await fetchJobById(jobId);
      if (cancelled) return;
      const saved = exactJob ? findSavedInvestigation(exactJob, requestedInvestigationId) : null;
      if (canReviewInvestigation(saved)) {
        setInvestigation(saved);
        setSuggestion(exactJob ? suggestReproduction(exactJob, saved) : null);
      } else {
        setRunError("The requested READY investigation could not be loaded. Provide a focused command or return to Investigate.");
      }
      setLoadingInvestigation(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, requestedJobId, requestedInvestigationId]);

  const runRepro = useCallback(async () => {
    if (!jobId || run === "running" || !script.trim()) return;
    const prepared = buildReproduceBody(jobId, requestedInvestigationId, script);
    if (!prepared.ok) {
      setRunError(prepared.error);
      return;
    }
    setRun("running");
    setRunError(null);
    setEvidence(null);
    try {
      const res = await fetch("/api/reproduce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const data = await res.json();
      if (!res.ok || !data.evidence) {
        setRunError(data.error ?? "Reproduction failed.");
        setRun("idle");
      } else {
        setEvidence(data.evidence as Evidence);
        setRun("done");
      }
    } catch {
      setRunError("Analysis service unreachable. Is the API running?");
      setRun("idle");
    }
  }, [jobId, requestedInvestigationId, run, script]);

  if (status === "loading") {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Reproduce</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">Loading workspace...</p>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Reproduce</p>
        <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">No analyzed repository</h1>
        <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
          Reproduction stages the analyzed repository into an isolated sandbox. Analyze a repository first so there is a source revision to stage.
        </p>
        <Link href={workspaceHref("/codebase", { jobId })} className="inline-flex mt-7 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3">
          ANALYZE REPOSITORY
        </Link>
      </div>
    );
  }

  const plan = investigation?.plan ?? null;
  const noSuggestion = !loadingInvestigation && (!investigation || !suggestion);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Reproduce{jobRepo ? ` - ${jobRepo}` : ""}</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">Reproduce the failure</h1>
      <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
        Describe or run the smallest command that demonstrates the reported failure. HUBRIS stages the analyzed source revision in a disposable sandbox.
      </p>

      {plan && (
        <section className="mt-8 max-w-3xl border border-[#dedada] bg-white/60 px-5 py-5">
          <p className="kicker">Based on investigation {requestedInvestigationId?.slice(0, 8)}</p>
          <dl className="mt-4 font-mono text-xs">
            <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Reported behavior</dt><dd className="text-right max-w-[70%]">{plan.currentBehavior}</dd></div>
            <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Target</dt><dd className="text-right">{plan.target.file} - {plan.target.function}()</dd></div>
            <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Expected</dt><dd className="text-right max-w-[70%]">{plan.expectedBehavior}</dd></div>
            {plan.reproduction && <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Relevant scenario</dt><dd className="text-right max-w-[70%]">{plan.reproduction.scenario} in {plan.reproduction.testFile}</dd></div>}
          </dl>
          <p className="kicker mt-5 mb-2">Evidence summary</p>
          {plan.evidence.slice(0, 4).map((item) => <p key={item} className="font-mono text-[11px] leading-5 text-[#7A7171]">- {item}</p>)}
        </section>
      )}

      <section className="mt-8 max-w-3xl border border-[#dedada] bg-white/60 px-5 py-5">
        <p className="kicker">What can I enter?</p>
        <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">
          TARGETED TEST runs an existing test that demonstrates the failure. CUSTOM REPRODUCTION runs a focused command or script you supply.
        </p>
        <p className="font-mono text-[11px] leading-6 text-[#7A7171] mt-3">
          Examples: pnpm test tests/cart.test.ts, npm test -- users.test.ts, pytest tests/test_sessions.py -q, python reproduce_bug.py, ./gradlew test --tests ...
        </p>
        {suggestion && (
          <div className="mt-5 border-t border-[#dedada] pt-4">
            <p className="kicker">Suggested reproduction</p>
            <p className="font-mono text-[12px] mt-2 break-all">{suggestion.command}</p>
            <p className="font-mono text-[11px] text-[#7A7171] mt-2">Why: {suggestion.reason}</p>
            <button type="button" onClick={() => setScript(suggestion.command)} className="mt-3 border border-[#0A0A0A] px-4 py-3 font-mono text-[11px] tracking-[0.08em]">
              USE SUGGESTED REPRODUCTION
            </button>
          </div>
        )}
        {noSuggestion && (
          <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-5">
            No existing test clearly reproduces this issue. Provide a focused command or return to Investigate.
          </p>
        )}
        <label htmlFor="repro-script" className="kicker mt-5 block">Command or custom reproduction</label>
        <textarea
          id="repro-script"
          rows={3}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          disabled={run === "running"}
          spellCheck={false}
          placeholder="Describe or run the smallest command that demonstrates the reported failure."
          className="mt-2 w-full bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
        />
        <button onClick={() => void runRepro()} disabled={run === "running" || !script.trim()} className="mt-3 inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white disabled:opacity-40">
          {run === "running" ? "RUNNING IN SANDBOX..." : "RUN REPRODUCTION"}
        </button>
        {runError && <p role="alert" className="font-mono text-xs mt-4">{runError}</p>}
        {evidence && (
          <div className="mt-5 border-t border-[#dedada] pt-4">
            <p className="hubris-status hubris-status-ready">{OUTCOME_COPY[evidence.outcome].title}</p>
            <p className="font-mono text-[12px] text-[#7A7171] mt-2">{OUTCOME_COPY[evidence.outcome].detail} {evidence.reason}</p>
            <dl className="mt-4 font-mono text-xs">
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Requested command</dt><dd className="mt-1 break-all">{evidence.requestedCommand ?? evidence.script}</dd></div>
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Executed command / wrapper</dt><dd className="mt-1 break-all whitespace-pre-wrap">{evidence.executedCommand ?? evidence.command}</dd></div>
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Setup</dt><dd className="mt-1">{evidence.setup?.status ?? evidence.installStatus ?? "-"}</dd></div>
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Execution</dt><dd className="mt-1">{evidence.execution?.status ?? evidence.outcome} - exit {String(evidence.exitCode)}</dd></div>
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Source</dt><dd className="mt-1 break-all">analysis {evidence.source?.analysisCommitSha ?? "-"} / execution {evidence.source?.executionCommitSha ?? "-"}</dd></div>
              <div className="py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Output</dt><dd className="mt-1 whitespace-pre-wrap break-all">{evidence.stdout || evidence.stderr || "(empty)"}</dd></div>
            </dl>
          </div>
        )}
        {run === "done" && evidence && (
          <p className="text-sm mt-5">
            <span className="font-semibold">Evidence stored on the job.</span>{" "}
            <Link href={workspaceHref("/forge", { jobId, investigationId: requestedInvestigationId })} className="underline underline-offset-4">
              Continue to Forge
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
