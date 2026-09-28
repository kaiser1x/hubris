"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import HubrisLogo from "./HubrisLogo";
import { useWorkspace } from "./WorkspaceProvider";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { workspaceHref } from "../lib/workspace";

const WORKSPACE_LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/codebase", label: "Codebase" },
  { href: "/trace", label: "Trace" },
  { href: "/investigate", label: "Investigate" },
  { href: "/reproduce", label: "Reproduce" },
  { href: "/forge", label: "Forge" },
  { href: "/verify", label: "Verify" },
];

const STAGE_LINKS = [
  { stage: "UNDERSTAND", href: "/overview" },
  { stage: "TRACE", href: "/trace" },
  { stage: "INVESTIGATE", href: "/investigate" },
  { stage: "REPRODUCE", href: "/reproduce" },
  { stage: "FORGE", href: "/forge" },
  { stage: "VERIFY", href: "/verify" },
  { stage: "SHIP", href: "/ship" },
] as const;

const STAGE_BY_ROUTE: Record<string, string> = {
  "/overview": "UNDERSTAND",
  "/codebase": "UNDERSTAND",
  "/trace": "TRACE",
  "/investigate": "INVESTIGATE",
  "/reproduce": "REPRODUCE",
  "/forge": "FORGE",
  "/verify": "VERIFY",
  "/ship": "SHIP",
  "/history": "HISTORY",
  "/settings": "SETTINGS",
};

const CRUMB: Record<string, string> = {
  "/overview": "OVERVIEW",
  "/codebase": "CODEBASE",
  "/trace": "TRACE",
  "/investigate": "INVESTIGATE",
  "/forge": "FORGE",
  "/verify": "VERIFY",
  "/reproduce": "REPRODUCE",
  "/ship": "SHIP",
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { status, job, repo } = useWorkspace();
  const active =
    WORKSPACE_LINKS.find((l) => l.href === pathname) ?? WORKSPACE_LINKS[0];
  const activeHref = pathname === "/history" ? "/history" : active.href;
  const crumb = CRUMB[pathname] ?? "OVERVIEW";
  const activeStage = STAGE_BY_ROUTE[pathname] ?? "";

  const investigationCount =
    job?.result && "investigationRuns" in job.result
      ? Array.isArray(job.result.investigationRuns)
        ? job.result.investigationRuns.length
        : 0
      : 0;
  const repoLabel =
    status === "loading" ? "Loading workspace…" : repo.label;
  const repoDetail =
    status === "ready" && repo.hasContext
      ? `${repo.ref ?? "default branch"} / ${repo.commitSha?.slice(0, 12) ?? "commit unavailable"}`
      : status === "loading"
        ? "…"
        : "no active analysis";

  return (
    <div className="min-h-screen flex bg-[#f8f7f6] text-[#0A0A0A]">
      {open && (
        <button
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 bg-black/30 z-20 lg:hidden"
        />
      )}
      <aside
        className={`fixed lg:static z-30 inset-y-0 left-0 w-[248px] shrink-0 bg-[#0A0A0A] text-white flex flex-col px-[18px] py-7 transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between px-2.5 pb-9">
          <Link
            href="/"
            onClick={() => setOpen(false)}
            aria-label="HUBRIS home"
          >
            <HubrisLogo tone="light" />
          </Link>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="lg:hidden text-[#979090] hover:text-white text-lg leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="border border-[#393737] px-2.5 py-3 flex items-center gap-2.5 mb-4">
          <span className="grid place-items-center w-6 h-6 bg-white text-[#0A0A0A] font-mono text-xs font-bold shrink-0">
            {repoLabel.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <strong className="block text-xs font-semibold truncate">
              {repoLabel}
            </strong>
            <small className="block text-[#8b8585] font-mono text-[10px] mt-1 truncate">
              {repoDetail}
            </small>
          </span>
        </div>
        <WorkspaceSwitcher />

        <nav aria-label="Workspace">
          <p className="font-mono text-[10px] tracking-[0.13em] text-[#686262] px-2.5 mb-2">
            WORKSPACE
          </p>
          <div className="flex flex-col gap-[3px]">
            {WORKSPACE_LINKS.map((l) => {
              const isActive = l.href === activeHref;
              return (
                <Link
                  key={l.href}
                  href={workspaceHref(l.href, { jobId: job?.id })}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-2.5 py-[11px] text-[13px] transition-colors border-l-2 ${
                    isActive
                      ? "bg-[#242323] text-white border-white"
                      : "text-[#979090] hover:text-white hover:bg-[#242323] border-transparent"
                  }`}
                >
                  <span>{l.label}</span>
                  {l.label === "Investigate" && investigationCount > 0 && (
                    <em className="ml-auto font-mono text-[10px] text-[#908989] not-italic">
                      {String(investigationCount).padStart(2, "0")}
                    </em>
                  )}
                </Link>
              );
            })}
          </div>
          <p className="font-mono text-[10px] tracking-[0.13em] text-[#686262] px-2.5 mb-2 mt-9">
            SYSTEM
          </p>
          <div className="flex flex-col gap-[3px]">
            <Link
              href={workspaceHref("/history", { jobId: job?.id })}
              aria-current={pathname === "/history" ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={`flex items-center px-2.5 py-[11px] text-[13px] border-l-2 transition-colors ${
                pathname === "/history"
                  ? "bg-[#242323] text-white border-white"
                  : "text-[#979090] hover:text-white hover:bg-[#242323] border-transparent"
              }`}
            >
              History
            </Link>
            <Link
              href={workspaceHref("/settings", { jobId: job?.id })}
              aria-current={pathname === "/settings" ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={`flex items-center px-2.5 py-[11px] text-[13px] border-l-2 transition-colors ${
                pathname === "/settings"
                  ? "bg-[#242323] text-white border-white"
                  : "text-[#979090] hover:text-white hover:bg-[#242323] border-transparent"
              }`}
            >
              Settings
            </Link>
          </div>
        </nav>

        <div className="mt-auto border-t border-[#302e2e] pt-4 px-2 flex items-center gap-2 text-[#857f7f] font-mono text-[9px]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-white breathe-dot" />
          <span>All systems operational</span>
          <span className="ml-auto">v0.9.4</span>
        </div>
      </aside>

      <div className="hubris-shell-content flex-1 min-w-0 flex flex-col">
        <header className="h-[64px] border-b border-[#dedada] flex items-center gap-3 px-5 lg:px-11 sticky top-0 bg-[#f8f7f6] z-10">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="lg:hidden text-xl leading-none px-1 text-[#0A0A0A]"
          >
            ☰
          </button>
          <p className="font-mono text-[10px] tracking-[0.1em] text-[#7A7171]">
            WORKSPACE <span className="mx-1">/</span>{" "}
            <strong className="text-[#0A0A0A] font-medium">{crumb}</strong>
          </p>
          <div className="ml-auto flex items-center gap-5">
            <span className="hidden sm:flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] text-[#7A7171]">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#0A0A0A] breathe-dot" />
              {status === "ready" && job ? "ANALYSIS COMPLETE" : "NO ACTIVE ANALYSIS"}
            </span>
            <span className="hidden md:inline font-mono text-[10px] text-[#7A7171]">
              {status === "ready" && repo.hasContext ? (repo.ref ?? "default branch") : "—"}
            </span>
            <span
              aria-label="Account"
              className="grid place-items-center w-[30px] h-[30px] border border-[#0A0A0A] font-mono text-[10px]"
            >
              YOU
            </span>
          </div>
        </header>

        <nav
          aria-label="Investigation workflow"
          className="border-b border-[#dedada] px-5 lg:px-11 pt-2.5 overflow-x-auto"
        >
          <ol className="flex gap-5 min-w-max font-mono text-[10px] tracking-[0.07em]">
            {STAGE_LINKS.map(({ stage, href }) => {
              const isActive = stage === activeStage;
              return (
                <li key={stage} className="pb-2 -mb-[11px]">
                  <Link
                     href={workspaceHref(href, { jobId: job?.id })}
                    aria-current={isActive ? "step" : undefined}
                    className={`inline-block border-b-2 pb-2 transition-colors focus:outline-none focus-visible:border-[#0A0A0A] ${
                      isActive
                        ? "text-[#0A0A0A] font-semibold border-[#0A0A0A]"
                        : "text-[#7A7171] border-transparent hover:text-[#0A0A0A] hover:border-[rgba(10,10,10,0.35)]"
                    }`}
                  >
                    {stage}
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex-1 min-w-0">{children}</div>

        <footer className="border-t border-[#dedada] px-5 lg:px-11 py-4 flex items-center justify-between font-mono text-[9px] tracking-[0.08em] text-[#7A7171]">
          <span>HUBRIS ENGINEERING INTELLIGENCE</span>
          <span className="hidden sm:inline">THE CASE IS NEVER CLOSED.</span>
        </footer>
      </div>
    </div>
  );
}
