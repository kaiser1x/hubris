"use client";

import Link from "next/link";
import { useState } from "react";

const CHECKLIST: [string, string][] = [
  ["Patch", "1 file · +1 −2 · src/services/transactions.ts"],
  ["Regression test", "concurrent-requests.test.ts · passes"],
  ["Full suite", "428 unit · 62 integration · green"],
  ["Typecheck and lint", "pass"],
  ["Production writes", "none · sandbox only"],
];

export default function ShipPage() {
  const [reviewed, setReviewed] = useState(false);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Ship · case-031</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Ready to ship
      </h1>
      <p className="text-[15px] text-[#7A7171] mt-4 max-w-2xl leading-7">
        The verified change is ready for final review. Nothing below merges
        itself. You approve, then it ships.
      </p>

      <div className="mt-8 max-w-2xl">
        <button
          onClick={() => setReviewed((v) => !v)}
          aria-expanded={reviewed}
          className="inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] transition-all"
        >
          {reviewed ? "HIDE REVIEW" : "REVIEW CHANGE"}
        </button>

        {reviewed && (
          <dl className="mt-6 font-mono text-xs border-t border-[#dedada]">
            {CHECKLIST.map(([k, v]) => (
              <div
                key={k}
                className="flex justify-between gap-4 py-2 border-b border-[#dedada]"
              >
                <dt className="text-[#7A7171] shrink-0">{k}</dt>
                <dd className="text-right break-all">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        <p className="text-sm mt-6">
          <Link
            href="/verify"
            className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] transition-colors underline underline-offset-4 decoration-[#dedada]"
          >
            BACK TO VERIFICATION
          </Link>
        </p>
      </div>
    </div>
  );
}
