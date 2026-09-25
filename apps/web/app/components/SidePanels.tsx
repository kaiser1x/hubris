"use client";

import { useEffect, useRef } from "react";

const CODE_LABELS = [
  "src/auth/session.ts",
  "TransactionService",
  "TransactionController",
  "Queue",
  "PostgreSQL",
  "middleware.ts",
  "worker.ts",
  "api/routes.ts",
  "dependency.graph",
  "trace_0184",
];

const EXEC_STAGES = ["REQUEST", "SERVICE", "QUEUE", "WORKER", "DATABASE"];

const BANNERS: [string, string][] = [
  ["TRACE COMPLETE", "06"],
  ["REPRODUCTION READY", "02"],
  ["DEPENDENCY MAPPED", "12"],
  ["PATCH VERIFIED", "01"],
  ["REGRESSION PASSED", "18"],
  ["CODEBASE SYNCED", "31"],
];

// Slight pointer parallax: inner layers drift a pixel or two toward the cursor.
function useParallax(ref: React.RefObject<HTMLDivElement | null>, factor: number) {
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const node: HTMLDivElement = el;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    function onMove(e: MouseEvent) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const nx = e.clientX / window.innerWidth - 0.5;
        const ny = e.clientY / window.innerHeight - 0.5;
        node.style.transform = `translate3d(${(nx * factor).toFixed(2)}px, ${(ny * factor).toFixed(2)}px, 0)`;
      });
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
    };
  }, [ref, factor]);
}

function LeftPanel() {
  const graphRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  useParallax(graphRef, 3);
  useParallax(labelsRef, 5);

  return (
    <aside
      aria-hidden="true"
      className="hubris-sidepanel pointer-events-none fixed inset-y-0 left-0 z-0 hidden w-[210px] min-[1400px]:block"
      style={{
        maskImage: "linear-gradient(to right, black 55%, transparent 96%)",
        WebkitMaskImage: "linear-gradient(to right, black 55%, transparent 96%)",
      }}
    >
      <div className="sp-grid absolute inset-0" />
      <div className="absolute inset-x-5 top-24 bottom-8 flex flex-col">
        <p className="font-mono text-[10px] tracking-[0.13em] text-[#7A7171]">
          CODEBASE / LIVE
        </p>

        <div ref={graphRef} className="mt-5 will-change-transform">
          <svg viewBox="0 0 170 150" className="w-full" aria-hidden="true">
            <g stroke="rgba(10,10,10,0.14)" strokeWidth="1">
              <path d="M20 25 H70 V60 H20 Z" fill="none" />
              <path d="M70 25 H120" />
              <path d="M120 25 V60" />
              <path d="M70 60 H70 V95" fill="none" />
              <path d="M20 95 H70" />
              <path d="M70 95 H120 V125" />
              <path d="M120 95 H150" />
              <path d="M120 125 H70" fill="none" />
              <path d="M20 60 V95" />
            </g>
            <g fill="rgba(10,10,10,0.28)">
              <circle cx="20" cy="25" r="2" />
              <circle cx="70" cy="25" r="2" />
              <circle cx="120" cy="25" r="2" />
              <circle cx="20" cy="60" r="2" />
              <circle cx="70" cy="60" r="2" />
              <circle cx="120" cy="60" r="2" />
              <circle cx="20" cy="95" r="2" />
              <circle cx="70" cy="95" r="2" />
              <circle cx="120" cy="95" r="2" />
              <circle cx="120" cy="125" r="2" />
              <circle cx="150" cy="95" r="2" />
            </g>
            <circle cx="70" cy="60" r="2.5" fill="rgba(10,10,10,0.4)" className="sp-node-pulse" />
            <circle cx="120" cy="95" r="2.5" fill="rgba(10,10,10,0.4)" className="sp-node-pulse sp-delay" />
          </svg>
        </div>

        <div className="relative mt-6 flex-1 min-h-0 overflow-hidden">
          <div ref={labelsRef} className="will-change-transform">
            <div className="sp-marquee flex flex-col gap-4" style={{ animationDuration: "21s" }}>
              {[...CODE_LABELS, ...CODE_LABELS].map((label, i) => (
                <span
                  key={`${label}-${i}`}
                  className="font-mono text-[10px] text-[rgba(10,10,10,0.42)] whitespace-nowrap"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="relative h-40 mt-4">
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[rgba(10,10,10,0.12)]" />
          <div className="sp-signal absolute left-1/2 top-0 -ml-[2.5px] w-[5px] h-[5px] rounded-full bg-[#0A0A0A]" />
        </div>
      </div>
      <div className="sp-scan absolute inset-x-0 top-0 h-px bg-[rgba(10,10,10,0.18)]" style={{ animationDuration: "13s" }} />
    </aside>
  );
}

function RightPanel() {
  const timelineRef = useRef<HTMLDivElement>(null);
  useParallax(timelineRef, -3);

  return (
    <aside
      aria-hidden="true"
      className="hubris-sidepanel pointer-events-none fixed inset-y-0 right-0 z-0 hidden w-[210px] min-[1400px]:block"
      style={{
        maskImage: "linear-gradient(to left, black 55%, transparent 96%)",
        WebkitMaskImage: "linear-gradient(to left, black 55%, transparent 96%)",
      }}
    >
      <div className="sp-grid absolute inset-0" />
      <div className="absolute inset-x-5 top-24 bottom-8 flex flex-col">
        <p className="font-mono text-[10px] tracking-[0.13em] text-[#7A7171] text-right">
          SYSTEM / LIVE
        </p>

        <div ref={timelineRef} className="mt-5 will-change-transform">
          {EXEC_STAGES.map((stage, i) => (
            <div key={stage}>
              <div className="flex items-center justify-end gap-2.5">
                <span className="font-mono text-[10px] text-[rgba(10,10,10,0.5)]">
                  {stage}
                </span>
                <span
                  className="sp-execdot inline-block w-[5px] h-[5px] rounded-full"
                  style={{ animationDelay: `${i * 2}s` }}
                />
              </div>
              {i < EXEC_STAGES.length - 1 && (
                <div className="flex justify-end pr-[1.5px] py-[3px]">
                  <span className="block w-px h-[18px] bg-[rgba(10,10,10,0.14)]" />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="relative mt-6 flex-1 min-h-0 overflow-hidden">
          <div className="sp-marquee flex flex-col gap-3" style={{ animationDuration: "17s" }}>
            {[...BANNERS, ...BANNERS].map(([label, n], i) => (
              <div
                key={`${label}-${i}`}
                className="flex items-center justify-between border border-[rgba(10,10,10,0.16)] bg-white/70 px-2.5 py-2"
              >
                <span className="font-mono text-[9px] tracking-[0.06em] text-[#0A0A0A]">
                  {label}
                </span>
                <span className="font-mono text-[9px] text-[#7A7171]">{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sp-scan absolute inset-x-0 top-0 h-px bg-[rgba(10,10,10,0.18)]" style={{ animationDuration: "18s", animationDelay: "4s" }} />
    </aside>
  );
}

export default function SidePanels() {
  return (
    <>
      <LeftPanel />
      <RightPanel />
    </>
  );
}
