"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import PromptEditor from "../../components/PromptEditor";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { fetchJobById } from "../../lib/live-twin";
import { DEMO_CASE } from "../../lib/demo-case";
import { workspaceHref } from "../../lib/workspace";
import {
  buildInvestigateBody,
  canReviewInvestigation,
  describeInvestigationFailure,
  findSavedInvestigation,
  forgeReviewHref,
  INVESTIGATE_PATH,
  toInvestigation,
  type InvestigationView,
} from "../../lib/forge-run";

export default function InvestigatePage() {
  return (
    <Suspense fallback={null}>
      <InvestigatePageContent />
    </Suspense>
  );
}

function InvestigatePageContent() {
  const { status, job, repo } = useWorkspace();
  const searchParams = useSearchParams();
  const jobId = job?.id ?? null;
  const requestedJobId = searchParams.get("jobId");
  const requestedInvestigationId = searchParams.get("investigationId");
  // Guided demo: prefill the known bug report (editable).
  const demoFocus = searchParams.get("demo") === "1" ? DEMO_CASE.focus : "";
  const [focus, setFocus] = useState(demoFocus);
  const [result, setResult] = useState<InvestigationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    setFocus(demoFocus);
    setResult(null);
    setError(null);
    setReviewing(false);
  }, [jobId, demoFocus]);

  // When navigated with ?jobId&investigationId (e.g. VIEW INVESTIGATION from
  // Forge), load the exact saved investigation for review. Investigation
  // itself owns creating new runs; this only displays a persisted one.
  useEffect(() => {
    const requested = requestedInvestigationId;
    if (!requested || !jobId || (requestedJobId && requestedJobId !== jobId)) {
      setReviewing(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      // Refresh the exact provider-selected job so persisted evidence is fresh.
      const exactJob = await fetchJobById(jobId);
      if (cancelled) return;
      const saved = exactJob ? findSavedInvestigation(exactJob, requested) : null;
      if (canReviewInvestigation(saved)) {
        setResult(saved);
        setReviewing(true);
      } else {
        setError("The requested READY investigation could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, requestedJobId, requestedInvestigationId]);

  async function investigate(option?: { id: string; label: string }) {
    if (!jobId || busy) return;
    const asked = result?.clarification ?? null;
    // Prefer the structured answer (stable question/option ids validated by
    // the API); fall back to free text only for legacy runs without ids.
    const clarification =
      option && asked?.questionId && result?.investigationId
        ? {
            priorInvestigationId: result.investigationId,
            questionId: asked.questionId,
            optionId: option.id,
          }
        : option
          ? { priorQuestion: asked?.question ?? "", answer: option.label }
          : undefined;
    const prepared = buildInvestigateBody(jobId, focus, clarification);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setReviewing(false);
    const clearedUrl = new URL(window.location.href);
    clearedUrl.searchParams.delete("investigationId");
    clearedUrl.searchParams.set("jobId", jobId);
    window.history.replaceState(null, "", `${clearedUrl.pathname}${clearedUrl.search}${clearedUrl.hash}`);
    try {
      const response = await fetch(INVESTIGATE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.body),
      });
      const raw = await response.text();
      let data: unknown = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = raw;
      }
      const parsed = response.ok ? toInvestigation(data) : null;
      if (!parsed) {
        // A rejected clarification answer carries a controlled, user-safe
        // explanation (stale question, changed description, ...).
        const body = (typeof data === "object" && data !== null ? data : {}) as {
          state?: unknown;
          error?: unknown;
        };
        const rejected =
          body.state === "STALE_CLARIFICATION" && typeof body.error === "string" ? body.error : null;
        setError(rejected ?? describeInvestigationFailure(response.status, INVESTIGATE_PATH, data));
      } else {
        setResult(parsed);
        if (canReviewInvestigation(parsed)) {
          const reviewedUrl = new URL(window.location.href);
          reviewedUrl.searchParams.set("jobId", parsed.jobId);
          reviewedUrl.searchParams.set("investigationId", parsed.investigationId);
          window.history.replaceState(null, "", `${reviewedUrl.pathname}${reviewedUrl.search}${reviewedUrl.hash}`);
        } else if (parsed.status === "READY") {
          setError("Investigation returned READY without a persisted investigation identity.");
        }
      }
    } catch {
      setError(describeInvestigationFailure(null, INVESTIGATE_PATH, undefined));
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Investigate</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading workspace…
        </p>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Investigate</p>
        <h1 className="font-display text-[clamp(30px,4vw,44px)] leading-[1.1] mt-4">
          No analyzed repository
        </h1>
        <p className="text-[15px] leading-7 text-[#7A7171] mt-4 max-w-2xl">
          Investigation grounds a suspected bug against the analyzed
          repository&apos;s CodeTwin. Analyze a repository first so HUBRIS has
          a real twin to match against.
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
        Repository / Investigate
        {repo.hasContext ? ` · ${repo.repoName}` : ""}
      </p>
      <h1 className="font-display text-[clamp(30px,4vw,44px)] leading-[1.1] mt-4 max-w-3xl">
        {reviewing ? "Review investigation" : "Describe what seems wrong."}
      </h1>
      <p className="text-[15px] leading-7 text-[#7A7171] mt-4 max-w-2xl">
        {reviewing
          ? "This is the saved investigation that a Forge run is bound to. Run a new investigation to create another READY plan."
          : "HUBRIS will ground the report against the analyzed repository. Investigation is read-only; no source code, tests, or sandbox are touched until you approve a READY plan in Forge."}
      </p>

      {!reviewing && (
        <form
          className="mt-10 max-w-3xl"
          onSubmit={(event) => {
            event.preventDefault();
            void investigate();
          }}
        >
          <PromptEditor
            id="investigation-focus"
            label="Describe what seems wrong"
            value={focus}
            onChange={setFocus}
            onSubmit={() => void investigate()}
            placeholder="Example: A retried operation creates a second record instead of returning the existing one."
            maxLength={500}
            disabled={busy || !jobId}
          />
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={busy || !jobId}
              className="bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-5 py-3 hover:bg-black active:scale-[0.98] disabled:opacity-40 transition-all"
            >
              {busy ? "INVESTIGATING…" : "INVESTIGATE ↗"}
            </button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="font-mono text-xs mt-4">{error}</p>}
      {result && (
        <section className="mt-10 border border-[#dedada] bg-white/60 px-5 py-5 max-w-4xl">
          <p className={`hubris-status ${result.status === "READY" ? "hubris-status-ready" : ""}`}>
            {result.status === "READY"
              ? "Likely bug"
              : result.state === "CLARIFICATION_NEEDED" || result.status === "AMBIGUOUS"
                ? "Needs clarification"
                : "No grounded match"}
          </p>
          {!result.plan && result.clarification && (
            <div className="mt-4">
              <p className="font-mono text-[13px] leading-6">{result.clarification.question}</p>
              <div className="mt-3 flex flex-col gap-2 max-w-xl">
                {result.clarification.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={busy || !jobId}
                    onClick={() => void investigate(option)}
                    className="text-left border border-[#0A0A0A] px-4 py-3 font-mono text-[11px] leading-5 hover:bg-white active:scale-[0.99] disabled:opacity-40"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="font-mono text-[11px] text-[#7A7171] mt-3">
                Or refine the description and investigate again.
              </p>
            </div>
          )}
          {result.plan ? (
            <>
              <p className="font-mono text-[13px] leading-6 mt-3">{result.plan.summary}</p>
              <dl className="font-mono text-xs mt-4">
                <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Target</dt><dd>{result.plan.target.file} · {result.plan.target.function}()</dd></div>
                <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Expected</dt><dd>{result.plan.expectedBehavior}</dd></div>
                <div className="flex justify-between gap-5 py-2 border-b border-[#dedada]"><dt className="text-[#7A7171]">Confidence</dt><dd>{result.plan.confidence.toUpperCase()}</dd></div>
              </dl>
              <p className="kicker mt-5 mb-2">Repair contract</p>
              <p className="font-mono text-[11px] leading-5">Required outcome: {result.plan.repairContract.requiredOutcome}</p>
              <p className="font-mono text-[11px] leading-5">Condition: {result.plan.repairContract.relevantCondition}</p>
              <p className="font-mono text-[11px] leading-5">Operation: {result.plan.repairContract.relevantOperation}</p>
              <p className="font-mono text-[11px] leading-5">Error contract: {result.plan.repairContract.existingErrorContract}</p>
              <p className="kicker mt-5 mb-2">Evidence</p>
              {result.plan.evidence.map((item) => <p key={item} className="font-mono text-[11px] leading-5 text-[#7A7171]">· {item}</p>)}
              {canReviewInvestigation(result) && (
                <Link
                  href={forgeReviewHref(result.jobId, result.investigationId)}
                  className="inline-flex mt-5 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] transition-all"
                >
                  REVIEW REPAIR →
                </Link>
              )}
            </>
          ) : (
            <>
              <p className="font-mono text-[13px] leading-6 text-[#7A7171] mt-3">
                {result.blocked?.reason ?? result.message}
              </p>
              {result.blocked && (
                <p className="font-mono text-[12px] leading-6 mt-3">Next step: {result.blocked.nextStep}</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
