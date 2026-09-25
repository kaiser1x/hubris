import Link from "next/link";
import { VERIFY_SEQUENCE } from "../../lib/casefile";

export default function VerifyPage() {
  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Verify · case-031</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        Verification record
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        Patch applied in sandbox neb-7f3a · no production writes
      </p>

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
