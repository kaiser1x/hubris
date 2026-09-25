"use client";

import Link from "next/link";
import { useState } from "react";

type RunState = "idle" | "running" | "done";

export default function ReproducePage() {
  const [run, setRun] = useState<RunState>("idle");

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
    </div>
  );
}
