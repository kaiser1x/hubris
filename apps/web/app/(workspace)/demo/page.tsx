"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DEMO_CASE, demoProgress, readDemoReply, type DemoStep } from "../../lib/demo-case";

// Analysis clones and maps a small repository; anything past this is stuck.
const START_TIMEOUT_MS = 150_000;
const READ_TIMEOUT_MS = 30_000;

type Phase = "idle" | "starting" | "ready" | "error";

export default function DemoPage() {
  return (
    <Suspense fallback={null}>
      <DemoPageContent />
    </Suspense>
  );
}

async function request(path: string, init: RequestInit, timeoutMs: number) {
  try {
    const res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return readDemoReply(res.status, await res.text());
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        ok: false as const,
        error: `No answer after ${Math.round(timeoutMs / 1000)}s. The service may be waking up (it sleeps when idle) — try again.`,
        code: "CLIENT_TIMEOUT",
      };
    }
    return { ok: false as const, error: "The demo service is unreachable. Check your connection and try again.", code: null };
  }
}

const STATE_STYLE: Record<DemoStep["state"], string> = {
  done: "text-[#1f6b3a]",
  failed: "text-[#9b2c2c]",
  pending: "text-[#7A7171]",
};

function DemoPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");
  const [phase, setPhase] = useState<Phase>(jobId ? "ready" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadJob = useCallback(async (id: string) => {
    setRefreshing(true);
    const out = await request(`/api/jobs/${encodeURIComponent(id)}`, {}, READ_TIMEOUT_MS);
    setRefreshing(false);
    if (out.ok) {
      setJob(out.data);
      setPhase("ready");
      setError(null);
    } else {
      setError(out.error);
      setPhase("error");
    }
  }, []);

  // Resume this browser's latest demo job (the list is scoped to the session
  // server-side), or load the one in the URL.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (jobId) {
        await loadJob(jobId);
        return;
      }
      const out = await request("/api/jobs?limit=5", {}, READ_TIMEOUT_MS);
      if (cancelled || !out.ok) return;
      const jobs = Array.isArray(out.data.jobs) ? out.data.jobs : [];
      const latest = jobs.find(
        (j: unknown) => typeof j === "object" && j !== null && (j as { status?: unknown }).status === "complete"
      ) as { id?: unknown } | undefined;
      if (typeof latest?.id === "string") router.replace(`/demo?jobId=${encodeURIComponent(latest.id)}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, loadJob, router]);

  async function start() {
    setPhase("starting");
    setError(null);
    const out = await request(
      "/api/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: DEMO_CASE.repoUrl, ref: DEMO_CASE.ref }),
      },
      START_TIMEOUT_MS
    );
    if (!out.ok || typeof out.data.jobId !== "string") {
      setError(out.ok ? "Analysis returned no job." : out.error);
      setPhase("error");
      return;
    }
    router.replace(`/demo?jobId=${encodeURIComponent(out.data.jobId)}`);
  }

  async function reset() {
    await request("/api/demo", { method: "POST" }, READ_TIMEOUT_MS);
    setJob(null);
    setError(null);
    setPhase("idle");
    router.replace("/demo");
  }

  const steps = job ? demoProgress(job) : null;

  return (
    <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Public demo</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">Try HUBRIS on a real bug</h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3 max-w-2xl leading-7">
        You will watch HUBRIS find, reproduce and fix a real defect: <code>{DEMO_CASE.target}</code> in{" "}
        <code>{DEMO_CASE.repository}</code> (branch <code>{DEMO_CASE.ref}</code>) accepts a repeated
        idempotency key. Every result below is read back from the run itself — nothing is pre-recorded.
        No account or keys needed.
      </p>

      <section className="mt-8 border border-[#dedada] bg-white/60 px-5 py-5 max-w-2xl" aria-label="Demo case">
        <dl className="font-mono text-[12px]">
          <div className="flex justify-between gap-4 py-1"><dt className="text-[#7A7171]">Repository</dt><dd>{DEMO_CASE.repository}</dd></div>
          <div className="flex justify-between gap-4 py-1"><dt className="text-[#7A7171]">Branch</dt><dd className="break-all text-right">{DEMO_CASE.ref}</dd></div>
          <div className="flex justify-between gap-4 py-1"><dt className="text-[#7A7171]">Target</dt><dd className="text-right">{DEMO_CASE.target}</dd></div>
          <div className="flex justify-between gap-4 py-1"><dt className="text-[#7A7171]">Scenario</dt><dd className="text-right">duplicate idempotency keys are rejected</dd></div>
        </dl>
        <div className="flex flex-wrap items-center gap-4 mt-5">
          {!jobId && (
            <button
              type="button"
              onClick={() => void start()}
              disabled={phase === "starting"}
              className="inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] disabled:opacity-40 transition-all"
            >
              {phase === "starting" ? "ANALYZING… (UP TO 2 MIN)" : "START THE DEMO"}
            </button>
          )}
          {jobId && (
            <button
              type="button"
              onClick={() => void loadJob(jobId)}
              disabled={refreshing}
              className="inline-flex h-10 items-center border border-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] disabled:opacity-40"
            >
              {refreshing ? "REFRESHING…" : "REFRESH RESULTS"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void reset()}
            className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A]"
          >
            START AGAIN
          </button>
        </div>
        {error && (
          <p role="alert" className="font-mono text-[12px] leading-6 text-[#9b2c2c] mt-4">
            {error}
          </p>
        )}
      </section>

      {steps && (
        <section className="mt-8 max-w-2xl" aria-label="Guided steps">
          <p className="kicker">Your run</p>
          <ol className="mt-3 border-t border-[#dedada]">
            {steps.map((s, i) => (
              <li key={s.key} className="flex items-start justify-between gap-4 py-3 border-b border-[#dedada]">
                <div>
                  <p className="font-mono text-[12px]">
                    {i + 1}. {s.title.toUpperCase()}{" "}
                    <span className={STATE_STYLE[s.state]}>· {s.state === "done" ? "done" : s.state === "failed" ? "see result" : "to do"}</span>
                  </p>
                  <p className="font-mono text-[11px] text-[#7A7171] mt-1 break-all">{s.evidence ?? "not run yet"}</p>
                </div>
                <Link href={s.href} className="font-mono text-[11px] tracking-[0.08em] underline underline-offset-4 shrink-0">
                  OPEN ↗
                </Link>
              </li>
            ))}
          </ol>
          <p className="font-mono text-[11px] text-[#7A7171] mt-3 leading-6">
            Work top to bottom. Investigate is prefilled with the bug report; Reproduce with the
            regression test command. Come back here and press REFRESH RESULTS to see each step&apos;s
            recorded outcome.
          </p>
        </section>
      )}

      <section className="mt-10 max-w-2xl" aria-label="How this demo works">
        <p className="kicker">How this demo works</p>
        <ul className="font-mono text-[12px] leading-7 text-[#3b3636] mt-3 list-disc pl-5">
          <li><b>Understand / Trace</b> — HUBRIS clones the branch and maps its functions, tests and call graph.</li>
          <li><b>Investigate</b> — your bug report is grounded in the actual source and tests; the result is READY only if it names a concrete target and regression scenario.</li>
          <li><b>Reproduce</b> — the regression test runs in a disposable sandbox and must fail on the buggy code.</li>
          <li><b>Forge</b> — the model proposes a minimal edit; HUBRIS applies it and checks it byte-for-byte.</li>
          <li><b>Verify</b> — the targeted test and the full suite run on the patched code; the counts shown are the sandbox&apos;s own.</li>
          <li><b>Ship</b> — shows the verified patch and provenance. The public demo never opens pull requests.</li>
        </ul>
        <p className="font-mono text-[11px] text-[#7A7171] mt-3 leading-6">
          Limits: this demo only works on the repository and branch above, your runs are private to this
          browser, and runs are rate-limited. A sandbox step can take a few minutes; if the service was
          idle, the first request may take up to a minute to wake it.
        </p>
      </section>
    </div>
  );
}
