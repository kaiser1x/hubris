import Link from "next/link";
import { workspaceHref } from "../lib/workspace";

// Shown when a Forge run has no investigation attached (or the attached one
// could not be loaded). Forge never re-runs investigation — it directs the
// user to the Investigation page instead.
export default function ForgeNoInvestigation({
  title = "No investigation is attached to this Forge run.",
  detail = "Forge consumes a saved investigation. Run one on the Investigation page, then its READY plan is carried here.",
  jobId,
}: {
  title?: string;
  detail?: string;
  jobId?: string | null;
}) {
  return (
    <div className="border border-[#dedada] px-5 py-10 mt-5 text-center">
      <p className="kicker">{title}</p>
      <p className="font-mono text-[12px] leading-6 text-[#7A7171] mt-3 max-w-xl mx-auto">
        {detail}
      </p>
      <Link
        href={workspaceHref("/investigate", { jobId })}
        className="inline-flex mt-6 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3 hover:bg-black active:scale-[0.98] transition-all"
      >
        GO TO INVESTIGATE ↗
      </Link>
    </div>
  );
}
