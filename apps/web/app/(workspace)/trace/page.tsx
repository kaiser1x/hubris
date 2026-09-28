"use client";

import { useEffect, useMemo, useState } from "react";
import { traceFromTwin, type LiveEndpoint } from "../../lib/live-twin";
import { useWorkspace } from "../../components/WorkspaceProvider";

export default function TracePage() {
  const { status, job, repo } = useWorkspace();
  const [selected, setSelected] = useState(0);
  const [entryKey, setEntryKey] = useState<string | null>(null);

  const endpoints: LiveEndpoint[] = job?.result?.full?.endpoints ?? [];
  const selectedEndpoint = entryKey
    ? endpoints.find((entry) => `${entry.method} ${entry.path}` === entryKey)
    : undefined;
  const steps = useMemo(
    () => (job ? traceFromTwin(job, 8, selectedEndpoint) : []),
    [job, selectedEndpoint]
  );
  const liveSteps = steps.length > 0 ? steps : null;

  useEffect(() => {
    setSelected(0);
    setEntryKey(null);
  }, [job?.id]);

  function pickEntry(method: string, path: string) {
    if (!job) return;
    setEntryKey(`${method} ${path}`);
    setSelected(0);
  }

  if (status === "loading") {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Trace</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading workspace…
        </p>
      </div>
    );
  }

  if (!liveSteps) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Trace</p>
        <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
          No call chain to trace
        </h1>
        <p className="font-mono text-[13px] text-[#7A7171] mt-3 max-w-xl leading-7">
          {status === "unavailable"
            ? "The workspace has no analyzed repository. Analyze one to trace request paths through its CodeTwin."
            : repo.hasContext
              ? "No detected HTTP endpoints for static request tracing."
              : "Repository context is unavailable for this job. Re-analyze to restore tracing."}
        </p>
      </div>
    );
  }

  const step = steps[Math.min(selected, steps.length - 1)];

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Trace{repo.hasContext ? ` · ${repo.repoName}` : ""}</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        {liveSteps[0].label}
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        {liveSteps.length} steps · static call chain · {repo.repoName ?? ""}
      </p>
      {endpoints.length > 1 && (
        <form
          className="flex flex-wrap gap-2 mt-4"
          onSubmit={(e) => e.preventDefault()}
        >
          <label htmlFor="trace-entry" className="kicker self-center">
            Entry
          </label>
          <select
            id="trace-entry"
            className="bg-white border border-[#dedada] px-2 py-2 font-mono text-[12px] focus:outline-none focus:border-[#0A0A0A] max-w-full"
            value={entryKey ?? `${liveSteps[0].label}`}
            onChange={(e) => {
              const [method, ...rest] = e.target.value.split(" ");
              pickEntry(method, rest.join(" "));
            }}
          >
            {endpoints.slice(0, 30).map((e) => (
              <option key={`${e.method} ${e.path}`} value={`${e.method} ${e.path}`}>
                {e.method} {e.path}
              </option>
            ))}
          </select>
        </form>
      )}

      <div className="grid gap-12 mt-10 lg:grid-cols-[1fr_280px]">
        <ol className="divide-y divide-[#dedada] border-y border-[#dedada]">
          {steps.map((s, i) => (
            <li key={`${s.label}-${i}`}>
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
