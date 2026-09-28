import Link from "next/link";
import type { ForgeRunView } from "../lib/forge-run";
import {
  RECENT_RUNS_LIMIT,
  toForgeHistoryRow,
} from "../lib/forge-run";

interface ForgeHistoryPanelProps {
  runs: ForgeRunView[];
  runsJob: string | null;
  runsChecked: boolean;
  onRefresh: () => void;
  onSelect: (run: ForgeRunView) => void;
}

// Compact recent-runs panel. Only the newest few runs render here; the full
// history lives at /history. Rows are keyboard-accessible buttons and carry
// explicit text status (never color-only). The page stays bounded no matter
// how many persisted runs exist.
export default function ForgeHistoryPanel({
  runs,
  runsJob,
  runsChecked,
  onRefresh,
  onSelect,
}: ForgeHistoryPanelProps) {
  const recent = runs.slice(0, RECENT_RUNS_LIMIT);
  return (
    <section className="mt-10 border-t border-[#dedada] pt-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="kicker">
          Recent Forge runs{runsJob ? ` · ${runsJob}` : ""}
          {runs.length > 0 ? ` · ${runs.length} total` : ""}
        </p>
        <div className="flex items-center gap-4 sm:ml-auto">
          <button
            type="button"
            onClick={onRefresh}
            disabled={!runsChecked}
            className="shrink-0 bg-white border border-[#0A0A0A] font-mono text-[11px] tracking-[0.08em] px-4 py-2 hover:bg-white/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            REFRESH
          </button>
          <Link
            href="/history"
            className="font-mono text-[11px] tracking-[0.08em] underline underline-offset-4 decoration-[#dedada] hover:text-[#7A7171]"
          >
            VIEW ALL HISTORY →
          </Link>
        </div>
      </div>

      {!runsChecked ? (
        <p className="mt-4 font-mono text-[13px] text-[#7A7171]">
          Loading persisted Forge runs…
        </p>
      ) : recent.length === 0 ? (
        <div className="mt-4 border-y border-[#dedada] py-5">
          <p className="kicker">No Forge runs yet</p>
          <p className="mt-3 font-mono text-[12px] leading-6 text-[#7A7171]">
            Nothing has been forged against this job. A structured run will
            appear here with its full stage trail.
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-[#dedada] border-y border-[#dedada]">
          {recent.map((run) => {
            const row = toForgeHistoryRow(run);
            const marker =
              run.outcome === "VERIFIED" ||
              run.outcome === "FULL_SUITE_PASSED" ||
              run.outcome === "REPAIR_VERIFIED"
                ? "✓"
                : "✕";
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelect(run)}
                  aria-label={`Open run #${run.number} · ${row.status} · ${row.target}`}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 py-3 text-left focus:outline-none focus-visible:bg-white/60"
                >
                  <span className="font-mono text-[10px] tracking-[0.08em] text-[#7A7171]">
                    #{run.number}
                  </span>
                  <span className="min-w-0">
                    <span className="font-mono text-[11px]">{marker} {row.status}</span>
                    <span className="ml-3 font-mono text-[11px] text-[#7A7171] truncate">
                      {row.target}
                    </span>
                  </span>
                  <span className="text-right font-mono text-[11px] text-[#7A7171]">
                    {row.summary} · {row.time}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}