"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchLatestJob, liveRepoName } from "../../lib/live-twin";

type RunState = "idle" | "running" | "done";

interface Evidence {
  script: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEMO_SCRIPT = "echo 'replay: 2 concurrent POST /api/transactions' && exit 2";

export default function ReproducePage() {
  const [run, setRun] = useState<RunState>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobRepo, setJobRepo] = useState<string | null>(null);
  const [script, setScript] = useState(DEMO_SCRIPT);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLatestJob().then((job) => {
      if (cancelled || !job) return;
      setJobId(job.id);
      setJobRepo(liveRepoName(job));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runRepro = useCallback(async () => {
    if (!jobId || run === "running" || !script.trim()) return;
    setRun("running");
    setRunError(null);
    setEvidence(null);
    try {
      const res = await fetch("/api/reproduce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, script: script.trim() }),
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
  }, [jobId, run, script]);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Reproduce · case-031</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Reproduce the failure
      </h1>
      <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
        HUBRIS prepares an isolated sandbox from the current investigation
        and replays the suspect requests. Nothing touches production.
      </p>

      {jobId ? (
        <div className="mt-8 max-w-2xl border border-[#dedada] bg-white/60 px-5 py-5">
          <p className="kicker">Live reproduction · {jobRepo} · disposable sandbox</p>
          <label htmlFor="repro-script" className="kicker mt-4 block">
            Repro script
          </label>
          <textarea
            id="repro-script"
            rows={3}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={run === "running"}
            spellCheck={false}
            className="mt-2 w-full bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
          />
          <button
            onClick={() => void runRepro()}
            disabled={run === "running" || !script.trim()}
            className="mt-3 inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {run === "running" ? "RUNNING IN SANDBOX…" : run === "done" ? "RUN AGAIN" : "RUN REPRODUCTION"}
          </button>
          {runError && (
            <p role="alert" className="font-mono text-xs mt-4 underline underline-offset-4 decoration-[#dedada]">
              {runError}
            </p>
          )}
          {evidence && (
            <dl className="mt-4 font-mono text-xs border-t border-[#dedada]">
              {(
                [
                  ["Exit code", String(evidence.exitCode)],
                  ["Timed out", String(evidence.timedOut)],
                  ["Stdout", evidence.stdout || "(empty)"],
                  ["Stderr", evidence.stderr || "(empty)"],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 py-2 border-b border-[#dedada]"
                >
                  <dt className="text-[#7A7171] shrink-0">{k}</dt>
                  <dd className="text-right break-all whitespace-pre-wrap">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {run === "done" && evidence && (
            <p className="text-sm mt-5">
              <span className="font-semibold">Evidence stored on the job.</span>{" "}
              <span className="text-[#7A7171]">
                <Link
                  href="/forge"
                  className="underline underline-offset-4 decoration-[#dedada] hover:text-black"
                >
                  Continue to Forge
                </Link>
                .
              </span>
            </p>
          )}
        </div>
      ) : (
      <div className="mt-8 max-w-2xl">
        <button
          onClick={() => {
            if (run !== "idle") return;
            setRun("running");
            setTimeout(() => setRun("done"), 1600);
          }}
          disabled={run !== "idle"}
          className="inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed transition-all"
        >
          {run === "idle" && "RUN REPRODUCTION"}
          {run === "running" && "PREPARING SANDBOX..."}
          {run === "done" && "REPRODUCTION COMPLETE"}
        </button>

        {run !== "idle" && (
          <div className="mt-6 border-t border-[#dedada]">
            <dl className="font-mono text-xs">
              {(
                [
                  ["Sandbox", "neb-7f3a · node 24 · clean checkout"],
                  ["Replay", "2 concurrent POST /api/transactions"],
                  ["Idempotency key", "idem_9f31 (shared)"],
                  ...(run === "done"
                    ? [["Result", "2 rows · failure reproduced"] as [string, string]]
                    : []),
                ] as [string, string][]
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 py-2 border-b border-[#dedada]"
                >
                  <dt className="text-[#7A7171] shrink-0">{k}</dt>
                  <dd className="text-right break-all">{v}</dd>
                </div>
              ))}
            </dl>
            {run === "done" && (
              <p className="text-sm mt-5">
                <span className="font-semibold">Reproduced.</span>{" "}
                <span className="text-[#7A7171]">
                  The evidence now supports forging a patch.{" "}
                  <Link
                    href="/forge"
                    className="underline underline-offset-4 decoration-[#dedada] hover:text-black"
                  >
                    Continue to Forge
                  </Link>
                  .
                </span>
              </p>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
