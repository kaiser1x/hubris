"use client";

import { useState } from "react";
import { TRACE } from "../../lib/casefile";

export default function TracePage() {
  const [selected, setSelected] = useState(1);

  const step = TRACE[selected];

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Trace</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        POST /api/transactions
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        6 steps · total about 119ms · trace_1842
      </p>

      <div className="grid gap-12 mt-10 lg:grid-cols-[1fr_280px]">
        <ol className="divide-y divide-[#dedada] border-y border-[#dedada]">
          {TRACE.map((s, i) => (
            <li key={s.label}>
              <button
                onClick={() => setSelected(i)}
                aria-pressed={selected === i}
                className={`w-full flex items-baseline gap-4 py-3 text-left transition-colors focus:outline-none ${
                  selected === i ? "bg-black/[0.03]" : "hover:bg-black/[0.02]"
                }`}
              >
                <span className="font-mono text-xs text-[#7A7171] w-7 shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-mono text-[13px] truncate">
                    {s.label}
                  </span>
                  <span className="block text-xs text-[#7A7171] mt-0.5">
                    {s.detail}
                  </span>
                </span>
                <span className="font-mono text-xs text-[#7A7171] shrink-0 hidden sm:inline">
                  {s.result}
                </span>
                <span className="font-mono text-xs text-[#0A0A0A] shrink-0 w-10 text-right">
                  {s.ms}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <aside className="border-t lg:border-t-0 lg:border-l border-[#dedada] pt-5 lg:pt-0 lg:pl-6 h-fit">
          <p className="kicker">Step {String(selected + 1).padStart(2, "0")}</p>
          <h3 className="font-mono text-[13px] font-semibold mt-2 break-all">
            {step.func}
          </h3>
          <dl className="mt-4 font-mono text-xs space-y-0">
            {(
              [
                ["File", step.file],
                ["Line", String(step.line)],
                ["Duration", step.ms],
                ["Result", step.result],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div
                key={k}
                className="flex justify-between gap-3 py-1.5 border-b border-[#dedada]"
              >
                <dt className="text-[#7A7171] shrink-0">{k}</dt>
                <dd className="text-right break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </div>
  );
}
