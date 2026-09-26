import type { ForgeRunView, VerifyResult } from "../lib/forge-run";

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0">
      <dt className="text-[#7A7171]">{label}</dt>
      <dd>{ok ? "✓" : "✕"}</dd>
    </div>
  );
}

function resultLabel(result: VerifyResult): string {
  if (result === "PASS") return "PASS";
  if (result === "FAIL") return "FAIL";
  return "NOT RUN";
}

function OutcomeBanner({ run }: { run: ForgeRunView }) {
  const v = run.verification;
  const summary = run.testSummary ? `${run.testSummary.passed} / ${run.testSummary.total}` : null;
  if (run.outcome === "VERIFIED") {
    return (
      <div className="border border-[#0A0A0A] px-5 py-5">
        <p className="font-display text-[34px] leading-none">VERIFIED</p>
        <p className="font-mono text-[12px] mt-3">Patch applied successfully in sandbox.</p>
        <p className="font-mono text-[12px] mt-1.5 text-[#7A7171]">
          {summary ? `${summary} tests passed` : "tests passed"} · exit {v?.exitCode ?? "—"} ·{" "}
          {v?.timedOut ? "timed out" : "no timeout"}
        </p>
      </div>
    );
  }
  const titles: Record<string, string> = {
    VERIFICATION_FAILED: "VERIFICATION FAILED",
    VERIFICATION_TIMEOUT: "VERIFICATION TIMED OUT",
    APPLY_FAILED: "PATCH APPLY FAILED",
    VALIDATION_FAILED: "PATCH VALIDATION FAILED",
    UNKNOWN: "UNKNOWN STATE",
  };
  const detail =
    run.outcome === "APPLY_FAILED"
      ? v
        ? `verification runner exited ${v.exitCode ?? "—"}`
        : "patch rejected before verification · Verification: NOT RUN"
      : run.outcome === "VALIDATION_FAILED"
        ? `backend state ${run.status} · later stages did not run`
        : run.outcome === "VERIFICATION_TIMEOUT"
          ? `${v?.command ?? "verification"} timed out`
          : v
            ? `${v.command} exited ${v.exitCode ?? "—"}${summary ? ` · tests ${summary}` : ""}`
            : "no verification evidence persisted";
  return (
    <div className="border border-[#dedada] px-5 py-5">
      <p className="font-display text-[28px] leading-none">{titles[run.outcome] ?? run.status}</p>
      <p className="font-mono text-[12px] mt-3 text-[#7A7171]">{detail}</p>
    </div>
  );
}

export default function ForgeRunPanel({ run }: { run: ForgeRunView }) {
  return (
    <article className="border border-[#dedada] bg-white/60">
      <div className="px-5 py-4 border-b border-[#dedada] flex items-baseline gap-3">
        <p className="kicker">
          Forge run · #{run.number}
        </p>
        <span className="font-mono text-[10px] text-[#7A7171]">
          {run.kind === "structured" ? "structured edit" : "unified diff"} · {run.status}
        </span>
        {run.at && (
          <span className="ml-auto font-mono text-[10px] text-[#7A7171] truncate max-w-[40%]">
            {run.at}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        <OutcomeBanner run={run} />
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Run sequence</p>
        <dl className="font-mono text-xs">
          {run.steps.map((s) => (
            <div
              key={s.label}
              className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0"
            >
              <dt className={s.reached ? "" : "text-[#7A7171]"}>{s.label}</dt>
              <dd className={s.reached ? "" : "text-[#7A7171]"}>{s.reached ? "✓" : "○"}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Model output</p>
        <dl className="font-mono text-xs">
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Source</dt>
            <dd>{run.modelSource ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Edits</dt>
            <dd>{run.edits.length > 0 ? `${run.edits.length} edit${run.edits.length === 1 ? "" : "s"}` : run.kind === "structured" ? "—" : "n/a · unified diff"}</dd>
          </div>
          {run.edits.map((e) => (
            <div key={e.path} className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0">
              <dt className="text-[#7A7171] truncate max-w-[60%]">{e.path}</dt>
              <dd>{e.function ? `${e.function}()` : "—"}</dd>
            </div>
          ))}
        </dl>
        {run.focus && (
          <p className="font-mono text-[11px] text-[#7A7171] mt-2 leading-5">
            Task: {run.focus}
          </p>
        )}
      </div>

      {run.kind === "structured" && (
        <div className="px-5 pb-4">
          <p className="kicker mb-2">Structured edit</p>
          <dl className="font-mono text-xs">
            {run.editChecks.map((c) => (
              <CheckRow key={c.label} label={c.label} ok={c.ok} />
            ))}
          </dl>
        </div>
      )}

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Patch</p>
        <dl className="font-mono text-xs">
          <CheckRow label="Canonical diff generated by HUBRIS" ok={run.patchShaShort !== null} />
          <CheckRow
            label="git diff --check"
            ok={run.kind === "structured" ? run.steps.find((s) => s.label === "Patch validated")?.reached ?? false : run.applyApplied || run.verification !== null}
          />
          <CheckRow
            label="git apply --check"
            ok={run.kind === "structured" ? run.steps.find((s) => s.label === "Patch validated")?.reached ?? false : run.applyApplied || run.verification !== null}
          />
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Bytes</dt>
            <dd>{run.patchBytes ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 last:border-b-0">
            <dt className="text-[#7A7171]">SHA-256</dt>
            <dd>{run.patchShaShort ?? "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Sandbox</p>
        <dl className="font-mono text-xs">
          {run.sandboxChecks.map((c) => (
            <CheckRow key={c.label} label={c.label} ok={c.ok} />
          ))}
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Image</dt>
            <dd className="truncate max-w-[60%] text-right">{run.sandbox.image ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 last:border-b-0">
            <dt className="text-[#7A7171]">Files · duration</dt>
            <dd>
              {run.sandbox.files ?? "—"} ·{" "}
              {run.sandbox.durationMs !== null ? `${(run.sandbox.durationMs / 1000).toFixed(1)}s` : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="px-5 pb-5">
        <p className="kicker mb-2">Verification</p>
        {!run.verification || !run.verification.started ? (
          <div>
            <p className="font-mono text-xs text-[#7A7171]">Verification: NOT RUN</p>
            {run.verification?.exitCode !== null && run.verification?.exitCode !== undefined && (
              <p className="font-mono text-[11px] text-[#7A7171] mt-1.5">
                runner exited {run.verification.exitCode} before verification began
              </p>
            )}
          </div>
        ) : (
          <dl className="font-mono text-xs">
            <div className="flex justify-between py-1.5 border-b border-[#dedada]">
              <dt className="text-[#7A7171]">Command</dt>
              <dd className="truncate max-w-[60%] text-right">{run.verification.command}</dd>
            </div>
            <div className="flex justify-between py-1.5 border-b border-[#dedada]">
              <dt className="text-[#7A7171]">Result</dt>
              <dd>{resultLabel(run.verification.result)}</dd>
            </div>
            <div className="flex justify-between py-1.5 border-b border-[#dedada]">
              <dt className="text-[#7A7171]">Exit code</dt>
              <dd>{run.verification.exitCode ?? "—"}</dd>
            </div>
            <div className="flex justify-between py-1.5 border-b border-[#dedada]">
              <dt className="text-[#7A7171]">Tests</dt>
              <dd>
                {run.testSummary ? `${run.testSummary.passed} / ${run.testSummary.total}` : "—"}
              </dd>
            </div>
            <div className="flex justify-between py-1.5 last:border-b-0">
              <dt className="text-[#7A7171]">Timeout</dt>
              <dd>{run.verification!.timedOut ? "Yes" : "No"}</dd>
            </div>
          </dl>
        )}
        {(run.outputTail.length > 0 || run.errorTail.length > 0) && (
          <details className="mt-3 border border-[#dedada] px-3 py-2">
            <summary className="font-mono text-[11px] cursor-pointer">
              View sandbox output
            </summary>
            <pre className="font-mono text-[11px] leading-6 mt-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {[...run.outputTail, ...run.errorTail.map((l) => `stderr: ${l}`)].join("\n")}
            </pre>
          </details>
        )}
      </div>
    </article>
  );
}
