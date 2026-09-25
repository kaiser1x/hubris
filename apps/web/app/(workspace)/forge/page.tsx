"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FORGE } from "../../lib/casefile";
import { fetchLatestJob, liveRepoName } from "../../lib/live-twin";

interface LiveProposal {
  repo: string;
  suggestion: string;
}

export default function ForgePage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<LiveProposal | null>(null);
  const [focus, setFocus] = useState("");
  const [forging, setForging] = useState(false);
  const [forgeError, setForgeError] = useState<string | null>(null);

  const forge = useCallback(async (id: string, repo: string, focusValue: string) => {
    setForging(true);
    setForgeError(null);
    try {
      const res = await fetch("/api/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          focusValue.trim() ? { jobId: id, focus: focusValue.trim() } : { jobId: id }
        ),
      });
      const data = await res.json();
      if (!res.ok || typeof data.suggestion !== "string") {
        setForgeError(data.error ?? "Forge request failed.");
        setProposal(null);
      } else {
        setProposal({ repo, suggestion: data.suggestion });
      }
    } catch {
      setForgeError("Analysis service unreachable. Is the API running?");
      setProposal(null);
    } finally {
      setForging(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const job = await fetchLatestJob();
      if (!job || cancelled) return;
      const repo = liveRepoName(job);
      setJobId(job.id);
      setProposal({ repo, suggestion: "" });
      await forge(job.id, repo, "");
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [forge]);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">
        Repository / Forge{proposal ? ` · live · ${proposal.repo}` : " · case-031"}
      </p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Proposed patch
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        src/services/transactions.ts · minimal diff · awaiting approval
      </p>

      {jobId && (
        <section className="mt-10 border border-[#dedada] bg-white/60 px-5 py-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="kicker">
              Live proposal · {proposal?.repo} · <span className="underline underline-offset-4">UNVERIFIED</span>
            </p>
            <form
              className="flex gap-2 sm:ml-auto"
              onSubmit={(e) => {
                e.preventDefault();
                if (jobId && !forging) void forge(jobId, proposal?.repo ?? "", focus);
              }}
            >
              <input
                type="text"
                aria-label="Focus area, e.g. a function or file name"
                placeholder="focus: function or file (optional)"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                disabled={forging}
                spellCheck={false}
                className="w-56 bg-white border border-[#dedada] px-2.5 py-2.5 font-mono text-[13px] placeholder:text-[#7A7171] focus:outline-none focus:border-[#0A0A0A] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={forging}
                className="bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-2.5 hover:bg-black active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {forging ? "FORGING…" : "REGENERATE ↗"}
              </button>
            </form>
          </div>
          {forging && !proposal?.suggestion ? (
            <p className="font-mono text-[13px] text-[#7A7171] mt-4">
              Asking the model for a minimal patch…
            </p>
          ) : forgeError ? (
            <p role="alert" className="font-mono text-xs mt-4 underline underline-offset-4 decoration-[#dedada]">
              {forgeError}
            </p>
          ) : proposal?.suggestion ? (
            <pre className="font-mono text-[12px] leading-[1.9] mt-4 whitespace-pre-wrap break-words max-w-4xl">
              {proposal.suggestion}
            </pre>
          ) : null}
          <p className="font-mono text-[10px] text-[#7A7171] mt-4">
            Proposal only — nothing applied. Sandbox verification pending.
          </p>
        </section>
      )}

      <div className="grid gap-10 mt-10 lg:grid-cols-2">
        <div>
          <p className="kicker mb-2">Current</p>
          <div className="bg-[#111] text-[#d8d4d4] font-mono text-[12px] leading-[2] pb-4 overflow-x-auto">
            <div className="flex justify-between border-b border-[#393535] px-4 py-2.5 text-[10px] text-[#938c8c]">
              <span>transactions.ts</span>
              <span>before</span>
            </div>
            {FORGE.current.map((line, i) => (
              <div key={line} className="grid grid-cols-[44px_1fr] px-4">
                <i className="text-[#686363] not-italic">{85 + i}</i>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="kicker mb-2">Proposed</p>
          <div className="bg-[#111] text-white font-mono text-[12px] leading-[2] pb-4 overflow-x-auto">
            <div className="flex justify-between border-b border-[#393535] px-4 py-2.5 text-[10px] text-[#938c8c]">
              <span>transactions.ts</span>
              <span>after</span>
            </div>
            {FORGE.proposed.map((line, i) => (
              <div
                key={line}
                className={`grid grid-cols-[44px_1fr] px-4 ${i === 1 ? "bg-[#2e2b2b]" : ""}`}
              >
                <i className="text-[#938c8c] not-italic">{85 + i}</i>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-10 mt-10 lg:grid-cols-3">
        <div>
          <h2 className="kicker">Why this patch</h2>
          <p className="text-sm text-[#7A7171] leading-7 mt-3">{FORGE.why}</p>
        </div>
        <div>
          <h2 className="kicker">Affected files</h2>
          <div className="mt-3">
            {FORGE.files.map((f) => (
              <p key={f} className="font-mono text-[13px] py-1">
                {f}
              </p>
            ))}
          </div>
        </div>
        <div>
          <h2 className="kicker">Expected impact</h2>
          <dl className="mt-3 font-mono text-xs">
            {FORGE.impact.map(([k, v]) => (
              <div
                key={k}
                className="flex justify-between py-1.5 border-b border-[#dedada]"
              >
                <dt className="text-[#7A7171]">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="flex items-center gap-4 mt-10">
        <Link
          href="/verify"
          className="inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] transition-all"
        >
          APPROVE AND VERIFY
        </Link>
        <span className="font-mono text-[11px] text-[#7A7171]">
          Human approval required before anything persists.
        </span>
      </div>
    </div>
  );
}
