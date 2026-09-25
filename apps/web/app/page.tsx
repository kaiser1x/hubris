import Link from "next/link";
import HubrisLogo from "./components/HubrisLogo";
import LivingTwin from "./components/LivingTwin";
import SidePanels from "./components/SidePanels";

const LOOP = [
  ["Understand", "Twin maps the repo into a dependency graph."],
  ["Trace", "Follow a request across services, queues, workers."],
  ["Reproduce", "Replay the failure in an isolated sandbox."],
  ["Forge", "Generate a regression test and a minimal patch."],
  ["Verify", "Re-run everything. Ship the evidence, not a claim."],
];

const STATS: [string, string, string][] = [
  ["Components mapped", "06", "across 5 layers"],
  ["Execution paths", "06", "traced end to end"],
  ["Regression tests", "428", "unit, all passing"],
  ["Integration tests", "62", "all passing"],
];

export default function Home() {
  return (
    <div className="bg-[#f8f7f6] text-[#0A0A0A]">
      <SidePanels />
      <header className="relative border-b border-[#dedada] bg-[#f8f7f6]">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center gap-3">
          <HubrisLogo tone="dark" />
          <Link
            href="/overview"
            className="text-sm text-[#7A7171] hover:text-[#0A0A0A] transition-colors ml-auto"
          >
            Open the workspace
          </Link>
        </div>
      </header>
      <section className="relative overflow-hidden">
        <LivingTwin />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E\")",
          }}
        />
        <div className="relative max-w-6xl mx-auto px-5 pt-14 pb-12">
          <p className="kicker">
            Nebius x NVIDIA hackathon · Coding and agentic engineering
          </p>
          <h1 className="font-display text-[clamp(38px,5vw,58px)] leading-[1.05] mt-4 max-w-2xl">
            Ship with earned confidence.
          </h1>
          <p className="font-mono text-[13px] text-[#7A7171] mt-4">
            A living case file for your codebase.
          </p>
          <p className="text-[15px] text-[#7A7171] mt-4 max-w-xl leading-7">
            HUBRIS maps your codebase, replays failures in a sandbox, and
            verifies fixes before you merge. It proves before it patches.
          </p>
          <div className="flex items-center gap-5 mt-7">
            <Link
              href="/codebase"
              className="group inline-flex h-10 items-center bg-[#0A0A0A] px-4 text-[11px] font-mono tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] transition-all"
            >
              OPEN THE TWIN
              <span
                aria-hidden="true"
                className="ml-2 inline-block transition-transform duration-200 group-hover:translate-x-[3px]"
              >
                →
              </span>
            </Link>
          <Link
            href="/api/analyze?repo=octocat/Hello-World"
            className="group/api inline-flex items-center font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] transition-colors underline underline-offset-4 decoration-[#dedada]"
          >
            TRY THE API
            <span
              aria-hidden="true"
              className="ml-1.5 inline-block transition-transform duration-200 group-hover/api:translate-x-[2px]"
            >
              ↗
            </span>
          </Link>
        </div>
        <p className="flex items-center gap-2 font-mono text-[11px] text-[#7A7171] mt-7">
          <span
            aria-hidden="true"
            className="inline-block w-1.5 h-1.5 rounded-full bg-[#0A0A0A] breathe-dot"
          />
          TWIN SYNCED · hubris-demo-ledger · main
        </p>
      </div>
    </section>

      <section className="max-w-6xl mx-auto px-5 pb-12">
        <div className="border-y border-[#dedada] grid grid-cols-2 md:grid-cols-4">
          {STATS.map(([label, value, sub], i) => (
            <div
              key={label}
              className={`py-5 pr-5 ${i > 0 ? "md:pl-5 md:border-l md:border-[#dedada]" : ""} ${i === 2 ? "max-md:border-l max-md:pl-5" : ""}`}
            >
              <p className="kicker">{label}</p>
              <p className="font-display text-[34px] leading-none mt-3">
                {value}
              </p>
              <p className="font-mono text-[11px] text-[#7A7171] mt-2">
                {sub}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 pb-12">
        <h2 className="kicker">How a run works</h2>
        <ol className="divide-y divide-[#dedada] border-b border-[#dedada] mt-3">
          {LOOP.map(([title, body]) => (
            <li
              key={title}
              className="group grid gap-1 sm:grid-cols-[160px_1fr] sm:gap-6 py-3.5 items-baseline px-2 -mx-2 hover:bg-black/[0.025] transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span
                  aria-hidden="true"
                  className="h-px w-4 origin-left scale-x-0 bg-[#0A0A0A] transition-transform duration-200 group-hover:scale-x-100"
                />
                {title}
              </span>
              <span className="text-sm text-[#7A7171]">{body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="max-w-6xl mx-auto px-5 pb-12 grid gap-10 lg:grid-cols-[1fr_320px] lg:gap-16">
        <div>
          <h2 className="kicker">The demo ledger</h2>
          <p className="font-mono text-[13px] mt-3 leading-7">
            POST /api/transactions
            <span className="text-[#7A7171]"> → </span>
            TransactionController
            <span className="text-[#7A7171]"> → </span>
            TransactionService
            <span className="text-[#7A7171]"> → </span>
            Queue
            <span className="text-[#7A7171]"> → </span>
            Worker
            <span className="text-[#7A7171]"> → </span>
            PostgreSQL
          </p>
          <p className="text-sm text-[#7A7171] mt-3 max-w-xl leading-7">
            Two concurrent requests for the same logical transaction created
            two rows. The twin traced the path, the sandbox reproduced it,
            and the patch added the missing pre-write idempotency guard,
            verified against 428 unit and 62 integration tests.
          </p>
        </div>
        <div className="font-mono text-xs leading-6 text-[#7A7171] lg:pt-8">
          <p>428 / 428 unit pass</p>
          <p>62 / 62 integration pass</p>
          <p>Typecheck pass</p>
          <p className="text-[#0A0A0A] font-medium mt-2">Verified.</p>
        </div>
      </section>

      <section className="border-t border-[#dedada]">
        <div className="max-w-6xl mx-auto px-5 py-12 grid gap-10 md:grid-cols-3 md:gap-8">
          <div>
            <p className="kicker">Twin</p>
            <h3 className="font-display text-[22px] mt-2">
              A model of the system.
            </h3>
            <p className="text-[13px] text-[#7A7171] leading-6 mt-2">
              Deterministic parsing: files, functions, APIs, tests, queues,
              infrastructure. The model reasons over facts and never invents
              the architecture.
            </p>
          </div>
          <div>
            <p className="kicker">Forge</p>
            <h3 className="font-display text-[22px] mt-2">
              An engineer that doubts itself.
            </h3>
            <p className="text-[13px] text-[#7A7171] leading-6 mt-2">
              Hypothesize, reproduce, falsify. It rejects its own wrong
              theories before proposing a minimal patch. You approve every
              persistent change.
            </p>
          </div>
          <div>
            <p className="kicker">Verify</p>
            <h3 className="font-display text-[22px] mt-2">
              Evidence, not confidence.
            </h3>
            <p className="text-[13px] text-[#7A7171] leading-6 mt-2">
              Reproduction, regression test, full suite, typecheck, lint.
              Reported as one evidence record you can hand to a reviewer.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#dedada]">
        <div className="max-w-6xl mx-auto px-5 py-5 flex items-center justify-between text-[11px] text-[#7A7171] font-mono">
          <span>HUBRIS ENGINEERING INTELLIGENCE</span>
          <span>CONFIDENCE, EARNED.</span>
        </div>
      </footer>
    </div>
  );
}
