"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchLatestJob, liveRepoName } from "../../lib/live-twin";

const CHECKLIST: [string, string][] = [
  ["Patch", "1 file · +1 −2 · src/services/transactions.ts"],
  ["Regression test", "concurrent-requests.test.ts · passes"],
  ["Full suite", "428 unit · 62 integration · green"],
  ["Typecheck and lint", "pass"],
  ["Production writes", "none · sandbox only"],
];

interface BundleRow {
  label: string;
  value: string;
}

function buildBundle(job: {
  result?: {
    stats?: { functions?: number; endpoints?: number; relationships?: number };
    reproductions?: Array<{ exitCode?: number | null }>;
    verifications?: Array<{ passed?: boolean }>;
  } | null;
}): { rows: BundleRow[]; ready: boolean } {
  const stats = job.result?.stats;
  const repros = job.result?.reproductions ?? [];
  const verifs = job.result?.verifications ?? [];
  const passed = verifs.filter((v) => v.passed).length;
  const rows: BundleRow[] = [
    {
      label: "Analysis",
      value: stats
        ? `${stats.functions ?? 0} functions · ${stats.endpoints ?? 0} endpoints · ${stats.relationships ?? 0} relationships`
        : "none",
    },
    {
      label: "Reproductions",
      value:
        repros.length > 0
          ? `${repros.length} run${repros.length === 1 ? "" : "s"} · exits ${repros.map((r) => String(r.exitCode)).join(", ")}`
          : "none yet",
    },
    {
      label: "Verifications",
      value:
        verifs.length > 0
          ? `${passed} / ${verifs.length} passed`
          : "none yet",
    },
    { label: "Production writes", value: "none · sandbox only" },
  ];
  return { rows, ready: repros.length > 0 && verifs.length > 0 && passed === verifs.length };
}

export default function ShipPage() {
  const [reviewed, setReviewed] = useState(false);
  const [bundle, setBundle] = useState<BundleRow[] | null>(null);
  const [ready, setReady] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLatestJob().then((job) => {
      if (cancelled || !job) return;
      const built = buildBundle(job);
      setBundle(built.rows);
      setReady(built.ready);
      setRepo(liveRepoName(job));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Ship{bundle ? ` · live · ${repo}` : " · case-031"}</p>
      <h1 className="font-display text-[clamp(32px,4vw,46px)] leading-[1.05] mt-4">
        {bundle ? (ready ? "Ready to ship" : "Evidence incomplete") : "Ready to ship"}
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
            {(bundle ?? CHECKLIST.map(([label, value]) => ({ label, value }))).map((row) => (
              <div
                key={row.label}
                className="flex justify-between gap-4 py-2 border-b border-[#dedada]"
              >
                <dt className="text-[#7A7171] shrink-0">{row.label}</dt>
                <dd className="text-right break-all">{row.value}</dd>
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
