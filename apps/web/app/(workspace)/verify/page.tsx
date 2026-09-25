"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { VERIFY_SEQUENCE } from "../../lib/casefile";
import { fetchLatestJob, liveRepoName } from "../../lib/live-twin";

interface Verification {
  script: string;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  at: string;
}

const DEMO_CHECK = "exit 0";

export default function VerifyPage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobRepo, setJobRepo] = useState<string | null>(null);
  const [script, setScript] = useState(DEMO_CHECK);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [history, setHistory] = useState<Verification[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchLatestJob().then((job) => {
      if (cancelled || !job) return;
      setJobId(job.id);
      setJobRepo(liveRepoName(job));
      const prior = (job.result as { verifications?: Verification[] } | null)?.verifications;
      if (Array.isArray(prior)) setHistory(prior);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runCheck = useCallback(async () => {
    if (!jobId || checking || !script.trim()) return;
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, script: script.trim() }),
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
  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Verify · case-031</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Verification record
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        Patch applied in sandbox neb-7f3a · no production writes
      </p>

      {jobId && (
        <section className="mt-10 max-w-2xl border border-[#dedada] bg-white/60 px-5 py-5">
          <p className="kicker">Live verification · {jobRepo} · disposable sandbox</p>
          <label htmlFor="verify-script" className="kicker mt-4 block">
            Check script (exit 0 = pass)
          </label>
          <textarea
            id="verify-script"
            rows={2}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={checking}
            spellCheck={false}
            className="mt-2 w-full bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
          />
          <button
            onClick={() => void runCheck()}
            disabled={checking || !script.trim()}
            className="mt-3 inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {checking ? "VERIFYING…" : "RUN CHECK"}
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
                      exit {String(v.exitCode)}{v.timedOut ? " · timed out" : ""} · {v.at}
                    </span>
                  </span>
                  <span className="font-mono text-xs shrink-0">
                    {v.passed ? "PASS ✓" : "FAIL"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <ol className="mt-10 max-w-2xl divide-y divide-[#dedada] border-y border-[#dedada]">
        {VERIFY_SEQUENCE.map(([step, result], i) => (
          <li key={step} className="flex items-baseline gap-4 py-3.5">
            <span className="font-mono text-xs text-[#7A7171] w-7 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="text-sm font-medium flex-1">{step}</span>
            <span className="font-mono text-xs">{result}</span>
          </li>
        ))}
      </ol>

      <p className="text-sm mt-8">
        <span className="font-semibold">Verified.</span>{" "}
        <span className="text-[#7A7171]">
          The duplicate is gone and the suite is green. Ready to ship.
        </span>
      </p>

      <div className="flex items-center gap-4 mt-6">
        <Link
          href="/investigate"
          className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] transition-colors underline underline-offset-4 decoration-[#dedada]"
        >
          BACK TO THE CASE
        </Link>
      </div>
    </div>
  );
}
