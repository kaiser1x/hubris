import type { InvestigationView } from "../lib/forge-run";
import type { JobRepositoryContext } from "../lib/workspace";

// Compact read-only summary of the persisted investigation that a Forge run
// is bound to. Consumes the saved InvestigationRun — it never re-runs or
// recreates investigation state.
export default function InvestigationSummary({
  investigation,
  repo,
}: {
  investigation: InvestigationView;
  repo: JobRepositoryContext;
}) {
  const plan = investigation.plan;
  if (!plan) {
    return (
      <div className="border border-[#dedada] px-5 py-5">
        <p className="kicker">Investigation · {investigation.status}</p>
        <p className="font-mono text-[12px] mt-3 leading-6 text-[#7A7171]">
          {investigation.message ?? "No grounded plan."}
        </p>
      </div>
    );
  }
  const contract = plan.repairContract;
  return (
    <div className="border border-[#dedada] bg-white/60 px-5 py-5">
      <div className="flex items-baseline justify-between gap-4 border-b border-[#dedada] pb-3">
        <p className="kicker">
          Investigation · {investigation.status} · confidence{" "}
          {plan.confidence.toUpperCase()}
        </p>
        {investigation.investigationId && (
          <span className="font-mono text-[10px] text-[#7A7171]">
            {investigation.investigationId.slice(0, 8)}
          </span>
        )}
      </div>

      <dl className="mt-4 font-mono text-xs space-y-0">
        <div className="flex justify-between gap-4 py-2 border-b border-[#dedada]">
          <dt className="text-[#7A7171] shrink-0">Status</dt>
          <dd>
            <span className="hubris-status hubris-status-ready">READY</span>
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-2 border-b border-[#dedada]">
          <dt className="text-[#7A7171] shrink-0">Target</dt>
          <dd className="text-right break-all">
            {plan.target.function}() · {plan.target.file}
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-2 border-b border-[#dedada]">
          <dt className="text-[#7A7171] shrink-0">Expected behavior</dt>
          <dd className="text-right break-all max-w-[70%]">
            {plan.expectedBehavior}
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-2 border-b border-[#dedada]">
          <dt className="text-[#7A7171] shrink-0">Source revision</dt>
          <dd className="text-right break-all">
            {repo.ref ?? "default branch"}
            {repo.commitSha ? ` · ${repo.commitSha.slice(0, 12)}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="kicker mb-1">Evidence</p>
        <ul className="space-y-1">
          {plan.evidence.map((line) => (
            <li key={line} className="font-mono text-[11px] leading-5 text-[#7A7171]">
              ✓ {line}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <p className="kicker mb-1">Repair contract</p>
        <dl className="font-mono text-[11px] space-y-1.5 text-[#7A7171]">
          {contract.requiredOutcome && (
            <div>
              <dt className="inline text-[#0A0A0A]">Expected outcome · </dt>
              <dd className="inline">{contract.requiredOutcome}</dd>
            </div>
          )}
          {contract.relevantCondition && (
            <div>
              <dt className="inline text-[#0A0A0A]">Relevant condition · </dt>
              <dd className="inline">{contract.relevantCondition}</dd>
            </div>
          )}
          {contract.relevantOperation && (
            <div>
              <dt className="inline text-[#0A0A0A]">Relevant operation · </dt>
              <dd className="inline">{contract.relevantOperation}</dd>
            </div>
          )}
          {contract.existingErrorContract && (
            <div>
              <dt className="inline text-[#0A0A0A]">Error contract · </dt>
              <dd className="inline">{contract.existingErrorContract}</dd>
            </div>
          )}
          {contract.minimalRepairDescription && (
            <div>
              <dt className="inline text-[#0A0A0A]">Minimal repair · </dt>
              <dd className="inline">{contract.minimalRepairDescription}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}