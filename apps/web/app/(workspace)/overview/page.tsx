"use client";

import Link from "next/link";
import { useState } from "react";
import { CASES, HEALTH, NODES, REPO } from "../../lib/casefile";

export default function OverviewPage() {
  const [analyzed, setAnalyzed] = useState(false);

  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Overview</p>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4 mt-4">
        <div>
          <h1 className="font-display text-[clamp(38px,5vw,58px)] leading-[1.05]">
            {REPO.name}
          </h1>
          <p className="font-mono text-[13px] text-[#7A7171] mt-3">
            A living case file for your codebase.
          </p>
        </div>
        <button
          onClick={() => {
            setAnalyzed(true);
            setTimeout(() => setAnalyzed(false), 1600);
          }}
          disabled={analyzed}
          className="sm:ml-auto shrink-0 bg-[#0A0A0A] text-white font-mono text-[11px] tracking-[0.08em] px-4 py-3.5 hover:bg-black active:scale-[0.98] disabled:opacity-70 transition-all"
        >
          {analyzed ? "ANALYZING..." : "ANALYZE REPOSITORY ↗"}
        </button>
      </div>

      <section className="mt-12">
        <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
          <div>
            <p className="kicker">01 / System state</p>
            <h2 className="font-display text-[25px] mt-2">Codebase health</h2>
          </div>
          <span className="font-mono text-[10px] text-[#7A7171]">
            ANALYSIS COMPLETE ✓
          </span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-[#dedada]">
          <div className="py-6 pr-5 border-r border-[#dedada]">
            <p className="font-display text-[46px] leading-none">
              98.4<span className="font-mono text-xs text-[#7A7171]"> / 100</span>
            </p>
            <p className="font-mono text-[11px] text-[#7A7171] mt-2.5">
              Confidence in current understanding
            </p>
            <div className="h-[3px] bg-[#d9d4d4] w-[90%] mt-4">
              <div className="bg-[#0A0A0A] h-full" style={{ width: "98.4%" }} />
            </div>
          </div>
          {HEALTH.slice(0, 3).map(([label, value, sub], i) => (
            <div
              key={label}
              className={`py-6 pr-5 ${i < 2 ? "pl-5 border-r border-[#dedada]" : "pl-5 max-lg:border-l max-lg:border-[#dedada]"} ${i === 0 ? "max-lg:border-l-0 max-lg:pl-0" : ""} max-lg:[&:nth-child(2)]:border-r-0`}
            >
              <p className="kicker">{label}</p>
              <p className="font-display text-[32px] mt-4">{value}</p>
              <p className="font-mono text-[10px] text-[#7A7171] mt-1.5">
                {sub}
              </p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-14 lg:grid-cols-[1.25fr_0.95fr] mt-[72px]">
        <section>
          <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
            <div>
              <p className="kicker">02 / Open cases</p>
              <h2 className="font-display text-[25px] mt-2">
                Active investigations
              </h2>
            </div>
            <Link
              href="/investigate"
              className="font-mono text-[10px] tracking-[0.08em] text-[#0A0A0A] hover:underline underline-offset-4"
            >
              VIEW ALL ↗
            </Link>
          </div>
          <div className="border-b border-[#dedada]">
            {CASES.map((c) => (
              <Link
                key={c.id}
                href="/investigate"
                className="grid grid-cols-[9px_1fr_auto] gap-4 items-start py-5 border-b border-[#dedada] last:border-b-0 hover:bg-white/60 transition-colors"
              >
                <span
                  aria-hidden
                  className={`w-[7px] h-[7px] mt-1 border border-[#0A0A0A] ${
                    c.status === "INVESTIGATING"
                      ? "bg-[#0A0A0A]"
                      : c.status === "VERIFIED"
                        ? "bg-[#7A7171] border-[#7A7171]"
                        : "bg-transparent"
                  }`}
                />
                <span>
                  <strong className="block font-display text-[15px] font-normal">
                    {c.title}
                  </strong>
                  <span className="block font-mono text-[10px] text-[#7A7171] mt-1.5">
                    {c.file} · line {c.line}
                  </span>
                  <small className="block font-mono text-[10px] text-[#7A7171] mt-3">
                    {c.meta}
                  </small>
                </span>
                <span className="font-mono text-[10px] text-[#7A7171]">
                  {c.status} ›
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
            <div>
              <p className="kicker">03 / Codetwin</p>
              <h2 className="font-display text-[25px] mt-2">Architecture</h2>
            </div>
            <Link
              href="/codebase"
              className="font-mono text-[10px] tracking-[0.08em] text-[#0A0A0A] hover:underline underline-offset-4"
            >
              OPEN ↗
            </Link>
          </div>
          <div
            className="mt-5 border border-[#dedada] px-4 py-5 font-mono text-[11px] leading-7"
            style={{
              backgroundImage: "radial-gradient(#d6d1d1 0.7px, transparent 0.7px)",
              backgroundSize: "13px 13px",
            }}
          >
            {NODES.map((n) => (
              <p key={n.id} className="truncate">
                <span className="text-[#7A7171]">{n.layer} / </span>
                {n.label}
              </p>
            ))}
          </div>
          <div className="border-t border-[#dedada] mt-4 pt-3.5 flex items-center justify-between">
            <div>
              <p className="kicker">Selected node</p>
              <p className="font-mono text-[13px] mt-1.5">
                src/services/transactions.ts
              </p>
            </div>
            <span className="font-mono text-[10px] text-[#7A7171]">
              12 dependencies ›
            </span>
          </div>
        </section>
      </div>

      <section className="mt-[72px] pb-12">
        <div className="flex items-end justify-between border-b border-[#dedada] pb-[15px]">
          <div>
            <p className="kicker">04 / Latest finding</p>
            <h2 className="font-display text-[25px] mt-2">
              Evidence, not guesses.
            </h2>
          </div>
          <span className="font-mono text-[10px] text-[#0A0A0A]">
            ■ HIGH CONFIDENCE
          </span>
        </div>
        <div className="grid gap-9 lg:grid-cols-3 pt-7">
          <div>
            <p className="kicker">Duplicate tx / case-031</p>
            <h3 className="font-display text-[24px] leading-[1.15] mt-4">
              Guard runs after the write it guards.
            </h3>
            <p className="font-mono text-xs leading-6 text-[#7A7171] mt-4">
              The idempotency check executes after the database write. Two
              concurrent requests both pass the guard before either row
              exists.
            </p>
            <p className="border-t border-[#dedada] mt-7 pt-3 flex items-baseline gap-3">
              <strong className="font-display text-[30px] font-normal">3</strong>
              <span className="font-mono text-[10px] text-[#7A7171]">
                execution traces support this hypothesis
              </span>
            </p>
          </div>
          <div className="bg-[#111] text-[#d8d4d4] font-mono text-[11px] leading-[2.1] pb-4 self-start w-full overflow-x-auto">
            <div className="flex justify-between border-b border-[#393535] px-3.5 py-2.5 text-[10px] text-[#938c8c]">
              <span>src/services/transactions.ts</span>
              <span>88:16</span>
            </div>
            <div className="grid grid-cols-[40px_1fr] px-3.5">
              <i className="text-[#686363] not-italic">85</i>
              <span>await createTransaction(data)</span>
            </div>
            <div className="grid grid-cols-[40px_1fr] px-3.5">
              <i className="text-[#686363] not-italic">86</i>
              <span>await markProcessed(id)</span>
            </div>
            <div className="grid grid-cols-[40px_1fr] px-3.5 bg-[#2e2b2b] text-white">
              <i className="text-[#938c8c] not-italic">88</i>
              <span>
                if (await seen(id)) return <b className="font-normal text-[#999] text-[10px] ml-2">← too late</b>
              </span>
            </div>
            <div className="grid grid-cols-[40px_1fr] px-3.5">
              <i className="text-[#686363] not-italic">89</i>
              <span>return transaction</span>
            </div>
          </div>
          <div className="lg:border-l lg:border-[#dedada] lg:pl-6">
            <p className="kicker">Supporting evidence</p>
            {[
              ["Execution trace", "trace_1842"],
              ["Reproduction", "repro_031 / passed"],
              ["Dependency path", "service → repo → db"],
            ].map(([t, s]) => (
              <Link
                key={t}
                href="/investigate"
                className="w-full flex items-center gap-3 border-b border-[#dedada] py-4 text-left hover:bg-white/60 transition-colors"
              >
                <span className="font-mono text-[11px]">
                  {t}
                  <small className="block text-[#7A7171] text-[10px] mt-1">
                    {s}
                  </small>
                </span>
                <span className="ml-auto text-[#7A7171]">›</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
