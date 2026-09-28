"use client";

import { useEffect, useRef } from "react";
import type { ForgeRunView } from "../lib/forge-run";
import { shortRunStatus } from "../lib/forge-run";
import ForgeRunPanel from "./ForgeRunPanel";

interface ForgeRunDrawerProps {
  run: ForgeRunView | null;
  onClose: () => void;
}

// Historical run detail drawer. The full transcript lives here, off the
// main page, so the current Forge workspace never competes with old runs.
// Focus moves into the panel and Escape closes it. Screen readers get the
// "Historical run" landmark via the labelled region.
export default function ForgeRunDrawer({ run, onClose }: ForgeRunDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (run) closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run, onClose]);

  if (!run) return null;

  return (
    <>
      <button
        aria-label="Close run details"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/25"
      />
      <aside
        aria-label={`Historical run #${run.number} · ${shortRunStatus(run)}`}
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 z-50 w-full max-w-[520px] overflow-y-auto border-l border-[#dedada] bg-[#f8f7f6] px-6 py-6"
      >
        <div className="flex items-baseline gap-3 border-b border-[#dedada] pb-4">
          <p className="kicker">Historical run · #{run.number}</p>
          <span className="font-mono text-[10px] text-[#7A7171]">{shortRunStatus(run)}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close run details"
            className="ml-auto font-mono text-[11px] tracking-[0.08em] underline underline-offset-4 decoration-[#dedada] hover:text-[#7A7171]"
          >
            CLOSE
          </button>
        </div>
        <div className="mt-4">
          <ForgeRunPanel run={run} />
        </div>
      </aside>
    </>
  );
}