import Link from "next/link";
import { FORGE } from "../../lib/casefile";

export default function ForgePage() {
  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Forge · case-031</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Proposed patch
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        src/services/transactions.ts · minimal diff · awaiting approval
      </p>

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
