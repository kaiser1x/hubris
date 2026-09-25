import Link from "next/link";
import { CASES, EVIDENCE, VERIFICATION } from "../../lib/casefile";

const primary = CASES[0];

export default function InvestigatePage() {
  return (
    <div className="max-w-[1440px] mx-auto px-5 lg:px-[52px] pt-10 lg:pt-[50px] pb-12">
      <p className="kicker">Repository / Investigate · {primary.id}</p>
      <h1 className="font-display text-[clamp(30px,4vw,44px)] leading-[1.1] mt-4 max-w-3xl">
        {primary.title}
      </h1>
      <p className="font-mono text-[13px] text-[#7A7171] mt-3">
        {primary.file}:{primary.line} · {primary.meta}
      </p>

      <div className="grid gap-12 mt-10 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <section>
            <h2 className="kicker">Problem</h2>
            <p className="text-[15px] leading-7 mt-3 max-w-2xl">
              Two concurrent requests for the same logical transaction both
              create a row. Customers see duplicate charges; the ledger no
              longer balances.
            </p>
          </section>

          <section className="mt-10">
            <h2 className="kicker">Evidence</h2>
            <ul className="mt-3 space-y-2.5">
              {EVIDENCE.map((e) => (
                <li
                  key={e}
                  className="text-sm text-[#7A7171] leading-6 border-l-2 border-[#dedada] pl-3 max-w-2xl"
                >
                  {e}
                </li>
              ))}
            </ul>
            <p className="font-mono text-xs mt-4">
              3 execution traces · 2 reproductions · 1 affected dependency
            </p>
          </section>

          <section className="mt-10">
            <h2 className="kicker">Hypothesis</h2>
            <p className="font-display text-[24px] leading-[1.2] mt-3 max-w-2xl">
              The idempotency guard runs after the write it guards.
            </p>
            <p className="text-sm text-[#7A7171] leading-7 mt-3 max-w-2xl">
              The idempotency check executes after the database write, so two
              concurrent requests both pass the guard before either row
              exists. Confidence: high. 3 traces support it, 0 contradict it.
            </p>
          </section>

          <section className="mt-10">
            <h2 className="kicker">Reproduction</h2>
            <p className="text-sm leading-7 mt-3 max-w-2xl">
              Sandbox sent two concurrent requests with the same idempotency
              key. Both returned 202. The ledger holds two rows where the
              contract allows exactly one.{" "}
              <Link
                href="/trace"
                className="underline underline-offset-4 decoration-[#dedada] hover:text-black"
              >
                Walk the trace
              </Link>
              .
            </p>
          </section>

          <section className="mt-10">
            <h2 className="kicker">Verification</h2>
            <dl className="mt-3 font-mono text-xs max-w-2xl">
              {VERIFICATION.map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between py-1.5 border-b border-[#dedada]"
                >
                  <dt className="text-[#7A7171]">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex items-center gap-4 mt-6">
              <Link
                href="/forge"
                className="inline-flex h-10 items-center bg-[#0A0A0A] px-4 font-mono text-[11px] tracking-[0.08em] text-white hover:bg-black active:scale-[0.98] transition-all"
              >
                REVIEW THE PATCH
              </Link>
              <Link
                href="/verify"
                className="font-mono text-[11px] tracking-[0.08em] text-[#7A7171] hover:text-[#0A0A0A] transition-colors underline underline-offset-4 decoration-[#dedada]"
              >
                VERIFICATION RECORD
              </Link>
            </div>
          </section>
        </div>

        <aside className="border-t lg:border-t-0 lg:border-l border-[#dedada] pt-5 lg:pt-0 lg:pl-6 h-fit">
          <p className="kicker">Other open cases</p>
          <div className="mt-3 space-y-1">
            {CASES.slice(1).map((c) => (
              <div
                key={c.id}
                className="border-l-2 border-[#dedada] pl-3 py-1.5"
              >
                <p className="text-sm font-medium leading-5">{c.title}</p>
                <p className="font-mono text-[11px] text-[#7A7171] mt-1">
                  {c.file}:{c.line} · {c.status}
                </p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
