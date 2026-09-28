"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../../components/WorkspaceProvider";
import { workspaceHref } from "../../lib/workspace";

interface Verification {
  script: string;
  requestedCommand?: string;
  actualCommand?: string | null;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  setup?: { status: string; reason?: string | null };
  execution?: { status: string; command?: string | null; exitCode?: number | null };
  result?: string;
  at: string;
}

export default function VerifyPage() {
  const { status, job, repo } = useWorkspace();
  const jobId = job?.id ?? null;
  const jobRepo = repo.hasContext ? repo.repoName : null;
  const [script, setScript] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [history, setHistory] = useState<Verification[]>([]);

  useEffect(() => {
    const prior = job?.result?.verifications;
    setHistory(Array.isArray(prior) ? (prior as unknown as Verification[]) : []);
    const manager = job?.result?.packageManager;
    const hasTestScript = typeof job?.result?.scripts?.test === "string";
    setScript(manager && hasTestScript ? `${manager} test` : "");
    setCheckError(null);
  }, [jobId, job]);

  const runCheck = useCallback(async () => {
    if (!jobId || checking || !script.trim()) return;
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, script: script.trim(), checkout: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.verification) {
        setCheckError(data.error ?? "Verification failed.");
      } else {
        setHistory((prev) => [...prev, data.verification as Verification]);
      }
    } catch {
      setCheckError("Analysis service unreachable. Is the API running?");
    } finally {
      setChecking(false);
    }
  }, [jobId, checking, script]);

  if (status === "loading") {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Verify</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading workspace…
        </p>
      </div>
    );
  }

  if (!jobId) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Verify</p>
        <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
          No analyzed repository
        </h1>
        <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
          Baseline verification runs checks against the analyzed source revision
          in a disposable sandbox. Forge changes are not applied. Analyze a
          repository first so there is a revision to verify against.
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

  const passed = history.filter((v) => v.passed).length;

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">
        Repository / Verify{jobRepo ? ` · ${jobRepo}` : ""}
      </p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Baseline verification
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        Checks run against the analyzed source revision. Forge changes are not
        applied.
      </p>

      <section className="mt-10 max-w-2xl border border-[#dedada] bg-white/60 px-5 py-5">
        <p className="kicker">Baseline check · {jobRepo ?? "analyzed repository"} · disposable sandbox</p>
        <p className="font-mono text-[11px] leading-5 text-[#7A7171] mt-2">
          Runs against the analyzed source revision without any Forge patch.
        </p>
         <label htmlFor="verify-script" className="kicker mt-4 block">
           Baseline check command
        </label>
        <textarea
          id="verify-script"
          rows={2}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          disabled={checking}
          spellCheck={false}
           placeholder={job?.result?.packageManager ? `${job.result.packageManager} test` : "Enter a repository-supported check command"}
          className="mt-2 w-full bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
        />
        <button
          onClick={() => void runCheck()}
          disabled={checking || !script.trim()}
          className="mt-3 inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {checking ? "CHECKING…" : "RUN BASELINE CHECK"}
        </button>
        {checkError && (
          <p role="alert" className="font-mono text-xs mt-4 underline underline-offset-4 decoration-[#dedada]">
            {checkError}
          </p>
        )}
        {history.length > 0 && (
          <ol className="mt-4 divide-y divide-[#dedada] border-y border-[#dedada]">
            {history.map((v, i) => (
              <li key={`${v.at}-${i}`} className="flex items-baseline gap-4 py-3">
                <span className="font-mono text-xs text-[#7A7171] w-7 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-mono text-[13px] truncate">{v.script}</span>
                   <span className="block font-mono text-[11px] text-[#7A7171] mt-0.5 truncate">
                     {v.result ?? (v.passed ? "PASS" : "TEST_FAILED")} · exit {String(v.exitCode)}{v.timedOut ? " · timed out" : ""} · {v.at}
                   </span>
                   <span className="block font-mono text-[10px] text-[#7A7171] mt-1 truncate">
                     setup {v.setup?.status ?? "—"} · execution {v.execution?.status ?? "—"}
                   </span>
                   <span className="block font-mono text-[10px] text-[#7A7171] mt-1 break-all">
                     command {v.actualCommand ?? v.requestedCommand ?? v.script}
                   </span>
                </span>
                <span className="font-mono text-xs shrink-0">
                  {v.passed ? "PASS ✓" : "FAIL"}
                </span>
              </li>
            ))}
          </ol>
        )}
        {history.length === 0 && (
          <p className="font-mono text-[12px] text-[#7A7171] mt-4">
            No baseline checks recorded against this revision yet.
          </p>
        )}
      </section>

      <section className="mt-8 max-w-2xl border border-[#dedada] px-5 py-5">
        <p className="kicker">Verify applied repair</p>
        <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3">
          Baseline verification never applies a patch, so it cannot confirm a
          repair. To verify an applied Forge repair, run Forge — its disposable
          sandbox applies the patch and verifies the result.
        </p>
        <Link
          href={workspaceHref("/forge", { jobId })}
          className="inline-flex mt-4 border border-[#0A0A0A] px-4 py-3 font-mono text-[11px] tracking-[0.08em] hover:bg-white active:scale-[0.98] transition-all"
        >
          GO TO FORGE ↗
        </Link>
      </section>

      <p className="text-sm mt-8 max-w-2xl">
        <span className="font-semibold">
          {history.length > 0
            ? `${passed} / ${history.length} baseline checks passing.`
            : "No baseline checks run yet."}
        </span>{" "}
        <span className="text-[#7A7171]">
          Baseline verification evidence is persisted on the job and shown in History.
        </span>
      </p>

      <div className="flex items-center gap-4 mt-6">
        <Link
          href={workspaceHref("/investigate", { jobId })}
          className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] transition-colors underline underline-offset-4 decoration-[#dedada]"
        >
          BACK TO THE CASE
        </Link>
      </div>
    </div>
  );
}
