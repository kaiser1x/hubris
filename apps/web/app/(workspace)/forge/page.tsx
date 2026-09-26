"use client";
import { useCallback, useEffect, useState } from "react";
import ForgeRunPanel from "../../components/ForgeRunPanel";
import {
  fetchLatestJob,
  fetchRecentJobs,
  liveRepoName,
  type LiveJob,
} from "../../lib/live-twin";
import {
  buildVerifyBody,
  findRunView,
  jobSourceRef,
  resolveForgeRuns,
  selectForgeEvidenceJob,
  STRUCTURED_VERIFY_PATH,
  toVerifyError,
  type ForgeRunView,
} from "../../lib/forge-run";

export default function ForgePage() {
  // Single canonical job: every action (regenerate, verify, evidence)
  // resolves its jobId from this state. No handler guesses or defaults it,
  // so a jobId-less request cannot be constructed.
  const [jobId, setJobId] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  // Current proposal identity: the backend run id adopted by the latest
  // successful action. Null means no current proposal — the page renders
  // NOT RUN even when history holds older VERIFIED runs.
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [acting, setActing] = useState<null | "regenerate" | "verify">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ForgeRunView[] | null>(null);
  const [runsJob, setRunsJob] = useState<string | null>(null);
  const [runsChecked, setRunsChecked] = useState(false);

  const loadRuns = useCallback(async () => {
    setRunsChecked(false);
    try {
      const jobs = await fetchRecentJobs(10);
      const evidence = selectForgeEvidenceJob(jobs);
      if (!evidence || typeof evidence !== "object") {
        setRuns([]);
        setRunsJob(null);
      } else {
        const job = evidence as LiveJob;
        setRuns(resolveForgeRuns(evidence).slice().reverse());
        const source = jobSourceRef(evidence);
        setRunsJob(
          `${liveRepoName(job)} · ${job.id.slice(0, 8)} · src: ${source ?? "default branch"}`
        );
      }
    } catch {
      setRuns([]);
      setRunsJob(null);
    } finally {
      setRunsChecked(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadRuns();
      const job = await fetchLatestJob();
      if (!cancelled && job) {
        setJobId(job.id);
        setRepo(liveRepoName(job));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRuns]);

  // Both actions run the proven structured pipeline for the canonical job
  // + current focus, then adopt the resulting run as current. Clearing the
  // current id FIRST guarantees a stale VERIFIED can never appear as the
  // outcome of the new proposal — not even while loading. No request is
  // ever sent without the canonical jobId (buildVerifyBody enforces it).
  async function runStructured(kind: "regenerate" | "verify") {
    if (!jobId || acting) return;
    const prepared = buildVerifyBody(jobId, focus);
    if (!prepared.ok) {
      setActionError(prepared.error);
      return;
    }
    setActing(kind);
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
        // Generation failed: history untouched, current stays empty
        // (NOT RUN) — an old VERIFIED is never shown as current.
        setActionError(toVerifyError(res.status, data));
        return;
      }
      // Explicit refresh only — the new run is now persisted evidence.
      await loadRuns();
      setCurrentRunId(runId);
    } catch {
      setActionError("Analysis service unreachable. Is the API running?");
    } finally {
      setActing(null);
    }
  }

  // Current proposal/verification derive from the adopted run id alone —
  // never from list position or jobId match — so history can never leak
  // into the current section.
  const current = currentRunId ? findRunView(runs ?? [], currentRunId) : null;
  const currentPaths = current
    ? [...new Set(current.edits.map((e) => e.path))]
    : [];

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">
        Repository / Forge{repo ? ` · live · ${repo}` : ""}
      </p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Proposed patch
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        {current && currentPaths.length > 0
          ? `${currentPaths.join(", ")} · structured edit · run ${current.id.slice(0, 8)}`
          : "no proposal yet · describe the bug below and regenerate"}
      </p>

      {jobId && (
        <section className="mt-10 border border-[#dedada] bg-white/60 px-5 py-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="kicker">
              Current proposal{focus.trim() ? ` · ${focus.trim().slice(0, 60)}` : ""}
            </p>
            <form
              className="flex flex-col sm:flex-row gap-2 sm:ml-auto"
              onSubmit={(e) => {
                e.preventDefault();
                if (jobId && !acting) void runStructured("regenerate");
              }}
            >
              <input
                type="text"
                aria-label="Bug description (required): what should the fix change"
                placeholder="bug: what should the fix change (required)"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                disabled={acting !== null}
                spellCheck={false}
                className="w-64 bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] placeholder:text-[#7A7171] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={acting !== null}
                  className="bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-2.5 hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {acting === "regenerate" ? "FORGING…" : "REGENERATE ↗"}
                </button>
                <button
                  type="button"
                  onClick={() => void runStructured("verify")}
                  disabled={acting !== null}
                  className="bg-white border border-[#0A0A0A] font-mono text-[11px] tracking-[0.08em] px-4 py-2.5 hover:bg-white/60 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {acting === "verify" ? "VERIFYING…" : "VERIFY IN SANDBOX ↗"}
                </button>
              </div>
            </form>
          </div>
          {acting ? (
            <p className="font-mono text-[13px] text-[#7A7171] mt-4">
              {acting === "regenerate"
                ? "Drafting a structured edit and running it in a disposable sandbox…"
                : "Applying the structured pipeline in a disposable sandbox…"}
            </p>
          ) : actionError ? (
            <p role="alert" className="font-mono text-xs mt-4 underline underline-offset-4 decoration-[#dedada]">
              {actionError}
            </p>
          ) : current ? (
            <div className="mt-4">
              <ForgeRunPanel run={current} />
            </div>
          ) : (
            <div className="border border-[#dedada] px-5 py-5 mt-4">
              <p className="kicker">Current verification · NOT RUN</p>
              <p className="font-mono text-[12px] mt-3 leading-6 text-[#7A7171]">
                No current proposal. Earlier runs below under history do not
                belong to a new proposal.
              </p>
            </div>
          )}
        </section>
      )}

      <section className="mt-10">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="kicker">
            History · persisted Forge runs{runsJob ? ` · ${runsJob}` : ""}
          </p>
          <button
            type="button"
            onClick={() => void loadRuns()}
            disabled={!runsChecked}
            className="sm:ml-auto shrink-0 bg-white border border-[#0A0A0A] font-mono text-[11px] tracking-[0.08em] px-4 py-2.5 hover:bg-white/60 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            REFRESH EVIDENCE
          </button>
        </div>
        <p className="font-mono text-[11px] text-[#7A7171] mt-3 leading-6">
          Controlled demo · kaiser1x/ts-js-dummy · bug: duplicate idempotency
          keys processed instead of rejected · fix: restore the duplicate-key
          guard, preserve the existing error message · verification: pnpm test
          · expected: 13 / 13 PASS
        </p>
        {!runsChecked ? (
          <p className="font-mono text-[13px] text-[#7A7171] mt-4">
            Loading persisted Forge evidence…
          </p>
        ) : !runs || runs.length === 0 ? (
          <div className="border border-[#dedada] bg-white/60 px-5 py-5 mt-4">
            <p className="kicker">No Forge runs yet</p>
            <p className="font-mono text-[12px] mt-3 leading-6">
              Nothing has been forged against this job. Run VERIFY IN SANDBOX
              above, or trigger a structured run — its persisted evidence will
              appear here with the full stage trail.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 mt-4">
            {runs.map((run) => (
              <ForgeRunPanel key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
