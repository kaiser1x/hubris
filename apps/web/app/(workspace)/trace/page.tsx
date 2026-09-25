"use client";

import { useEffect, useState } from "react";
import { TRACE, type TraceStep } from "../../lib/casefile";
import { fetchLatestJob, liveRepoName, traceFromTwin, type LiveEndpoint, type LiveJob } from "../../lib/live-twin";

export default function TracePage() {
  const [selected, setSelected] = useState(1);
  const [liveSteps, setLiveSteps] = useState<TraceStep[] | null>(null);
  const [liveName, setLiveName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [job, setJob] = useState<LiveJob | null>(null);
  const [entryKey, setEntryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLatestJob()
      .then((j) => {
        if (cancelled) return;
        if (j) {
          try {
            const steps = traceFromTwin(j);
            if (steps.length > 0) {
              setJob(j);
              setLiveSteps(steps);
              setLiveName(liveRepoName(j));
              setSelected(0);
            }
          } catch {
            // fall through to demo narrative
          }
        }
      })
      .catch(() => {
        // fall through to demo narrative
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const endpoints: LiveEndpoint[] = job?.result?.full?.endpoints ?? [];

  function pickEntry(method: string, path: string) {
    if (!job) return;
    setEntryKey(`${method} ${path}`);
    const steps = traceFromTwin(job, 8, { method, path, file: "" });
    if (steps.length > 0) {
      setLiveSteps(steps);
      setSelected(0);
    }
  }

  if (!checked) {
    return (
      <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
        <p className="kicker">Repository / Trace</p>
        <p className="font-mono text-[13px] text-[#7A7171] mt-4">
          Loading twin…
        </p>
      </div>
    );
  }

  const steps = liveSteps ?? TRACE;
  const step = steps[Math.min(selected, steps.length - 1)];

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Trace{liveSteps ? " · static call chain" : ""}</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        {liveSteps ? liveSteps[0].label : "POST /api/transactions"}
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        {liveSteps
          ? `${liveSteps.length} steps · static, not measured · ${liveName}`
          : "6 steps · total about 119ms · trace_1842"}
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
            value={entryKey ?? `${liveSteps?.[0]?.label ?? ""}`}
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
